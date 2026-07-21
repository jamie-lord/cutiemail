/**
 * The daemon's operational log trail. Before this,
 * accepted mail, submissions, and — worst — failed authentication produced ZERO log output:
 * an operator could not see a credential-stuffing run at all, and DEPLOYMENT.md promised
 * journalctl lines that did not exist. These tests pin the trail end to end through
 * startServer's onEvent:
 *
 *   - a wrong submission AUTH logs the attempted login + source IP;
 *   - crossing the throttle threshold logs an "engaged" line (per protocol);
 *   - a wrong IMAP LOGIN logs the same;
 *   - an accepted inbound message logs one line with envelope, size, auth verdicts, and
 *     where it was filed;
 *   - an accepted submission logs one line naming the authenticated user.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer, type MailServerConfig, type RunningServer } from '../main.ts';
import { AuthThrottle } from './auth-throttle.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mail.example.test';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plainToken = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

async function boot(lines: string[]): Promise<RunningServer> {
  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: DOMAIN,
    accounts: [{ user: 'alice', pass: 's3cret-passphrase' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    onEvent: (l) => lines.push(l),
    // A low threshold so the "throttle engaged" line is reachable in two failures.
    authThrottle: new AuthThrottle({ maxFailures: 2, windowMs: 60_000 }),
  };
  return startServer(config);
}

class Reader {
  #acc = Buffer.alloc(0);
  constructor(sock: NodeJS.ReadableStream) {
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
  }
  async line(needle: string): Promise<void> {
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(n);
      if (at !== -1) {
        this.#acc = this.#acc.subarray(at + n.length);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

/** STARTTLS + AUTH PLAIN with the given creds; returns the secure socket + reader after the auth reply. */
async function submissionAuth(port: number, user: string, pass: string): Promise<{ secure: tls.TLSSocket; reader: Reader; authReply: string }> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const rr = new Reader(raw);
  await rr.line('ESMTP\r\n');
  raw.write('EHLO client.example\r\n');
  await rr.line('250 STARTTLS\r\n');
  raw.write('STARTTLS\r\n');
  await rr.line('Ready to start TLS\r\n');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  const reader = new Reader(secure);
  secure.write('EHLO client.example\r\n');
  await reader.line('250 AUTH PLAIN\r\n');
  secure.write('AUTH PLAIN ' + plainToken(user, pass) + '\r\n');
  // Wait for either outcome line.
  let authReply = '';
  const acc: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no auth reply (saw ${acc.join('|')})`)), 2000);
    secure.on('data', (d: Buffer) => {
      acc.push(d.toString('latin1'));
      const s = acc.join('');
      const m = /(\d{3} [^\r\n]*)\r\n/.exec(s);
      if (m) {
        authReply = m[1]!;
        clearTimeout(t);
        resolve();
      }
    });
  });
  return { secure, reader, authReply };
}

test('failed submission AUTH and throttle engagement are logged with login and IP', async () => {
  const lines: string[] = [];
  const server = await boot(lines);
  try {
    const a = await submissionAuth(server.submission.port, 'alice', 'wrong-password');
    assert.match(a.authReply, /^535 /);
    a.secure.destroy();
    const b = await submissionAuth(server.submission.port, 'alice', 'still-wrong');
    assert.match(b.authReply, /^535 /);
    b.secure.destroy();

    const failures = lines.filter((l) => l.includes('submission auth failed'));
    assert.equal(failures.length, 2, `both failures logged: ${JSON.stringify(lines)}`);
    assert.match(failures[0]!, /"alice"/, 'the attempted login is named');
    assert.match(failures[0]!, /from 127\.0\.0\.1/, 'the source IP is named');
    assert.ok(lines.some((l) => l.includes('auth throttle engaged') && l.includes('(submission)')), `crossing the threshold logs engagement: ${JSON.stringify(lines)}`);
  } finally {
    await server.close();
  }
});

test('failed IMAP LOGIN is logged with login and IP', async () => {
  const lines: string[] = [];
  const server = await boot(lines);
  try {
    const sock = tls.connect({ port: server.imap.port, host: '127.0.0.1', rejectUnauthorized: false });
    sock.on('error', () => {});
    const rr = new Reader(sock);
    await new Promise<void>((r) => sock.once('secureConnect', () => r()));
    await rr.line('* OK');
    sock.write('a1 LOGIN alice wrong-password\r\n');
    await rr.line('a1 NO');
    sock.end();
    const failure = lines.find((l) => l.includes('imap auth failed'));
    assert.ok(failure !== undefined, `the IMAP failure is logged: ${JSON.stringify(lines)}`);
    assert.match(failure, /"alice"/);
    assert.match(failure, /from 127\.0\.0\.1/);
  } finally {
    await server.close();
  }
});

test('an accepted inbound message logs one line: envelope, size, verdicts, filing', async () => {
  const lines: string[] = [];
  const server = await boot(lines);
  try {
    const data = Buffer.from('Subject: observability\r\n\r\nbody\r\n', 'latin1');
    const sent = await deliver(
      { host: '127.0.0.1', port: server.inbound.port, tls: 'none' },
      { from: 'someone@example.net', recipients: [`alice@${DOMAIN}`], data, clientName: 'sender.example.net' },
    );
    assert.ok(sent.ok, `delivery succeeds: ${sent.failure}`);
    const line = lines.find((l) => l.startsWith('inbound '));
    assert.ok(line !== undefined, `an inbound line is logged: ${JSON.stringify(lines)}`);
    assert.match(line, /from=<someone@example\.net>/);
    assert.match(line, /to=<alice@mail\.example\.test>/);
    assert.match(line, /size=\d+/);
    assert.match(line, /dkim=\w+ spf=\w+ dmarc=\w+/, 'the auth verdicts are on the line');
    assert.match(line, /filed=INBOX/, 'where it was filed is on the line');
  } finally {
    await server.close();
  }
});

test('an accepted submission logs one line naming the authenticated user', async () => {
  const lines: string[] = [];
  const server = await boot(lines);
  try {
    const { secure, reader, authReply } = await submissionAuth(server.submission.port, 'alice', 's3cret-passphrase');
    assert.match(authReply, /^235 /);
    secure.write(`MAIL FROM:<alice@${DOMAIN}>\r\n`);
    await reader.line('250');
    secure.write(`RCPT TO:<alice@${DOMAIN}>\r\n`);
    await reader.line('250');
    secure.write('DATA\r\n');
    await reader.line('354');
    secure.write(`From: alice@${DOMAIN}\r\nTo: alice@${DOMAIN}\r\nSubject: note to self\r\n\r\nhi\r\n.\r\n`);
    await reader.line('250');
    secure.end();
    const line = lines.find((l) => l.startsWith('submission '));
    assert.ok(line !== undefined, `a submission line is logged: ${JSON.stringify(lines)}`);
    assert.match(line, /user=alice/);
    assert.match(line, /local=1 remote=0/);
    assert.match(line, /size=\d+/);
  } finally {
    await server.close();
  }
});
