/**
 * Authentication-Results forgery via the envelope (RFC 8601 §2.2 / §5). A client
 * reads OUR Authentication-Results header to decide whether a message is authentic,
 * so an attacker who can inject text into the header we stamp can forge dkim=pass /
 * spf=pass / dmarc=pass under our own authserv-id — a phishing primitive. The header
 * splices in the MAIL FROM domain (and HELO for a null return-path); those are
 * attacker-controlled and may contain the AR delimiters ";" "=" and space. This
 * proves such input cannot introduce a forged method result into our stamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { readMessages } from '../testing/read-messages.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONFIG: MailServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  smtpPort: 0,
  submissionPort: 0,
  imapPort: 0,
  domain: 'mail.example.test',
  accounts: [{ user: 'you', pass: 'pw' }],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

/** Deliver a message with a caller-chosen MAIL FROM and HELO, return the stored bytes. */
async function deliverWithEnvelope(port: number, helo: string, mailFrom: string): Promise<void> {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {});
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
  const until = async (needle: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (acc.includes(Buffer.from(needle, 'latin1'))) {
        acc = Buffer.alloc(0);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out on ${needle}`);
  };
  await until('ESMTP');
  sock.write(Buffer.from(`EHLO ${helo}\r\n`, 'latin1'));
  await until('250 ');
  sock.write(Buffer.from(`MAIL FROM:<${mailFrom}>\r\n`, 'latin1'));
  await until('250 ');
  sock.write(Buffer.from('RCPT TO:<you@mail.example.test>\r\n', 'latin1'));
  await until('250 ');
  sock.write(Buffer.from('DATA\r\n', 'latin1'));
  await until('354');
  sock.write(Buffer.from('Subject: hi\r\n\r\nbody\r\n.\r\n', 'latin1'));
  await until('message stored');
  sock.end();
}

/** The Authentication-Results header line the server stamped (bearing our authserv-id). */
function ourAr(stored: string): string {
  const line = stored.split('\r\n').find((l) => /^Authentication-Results: mail\.example\.test/i.test(l));
  return line ?? '';
}

test('a MAIL FROM domain carrying AR delimiters cannot forge a method result in our stamp', async () => {
  const server = await startServer(CONFIG);
  try {
    // The domain part is packed with a forged "dkim=pass" resinfo.
    await deliverWithEnvelope(server.inbound.port, 'probe.example', 'x@evil.test; dkim=pass header.d=bank.test (yes)');
    assert.equal(readMessages(server.mailbox).length, 1);
    const ar = ourAr(readMessages(server.mailbox)[0]!.raw.toString('latin1'));
    assert.ok(ar.length > 0, 'the server stamped its own Authentication-Results');
    // Our genuine verdict is dkim=none (no signature); a dkim=pass anywhere in our
    // header means the envelope forged one.
    assert.doesNotMatch(ar, /dkim=pass/, 'no forged dkim=pass is injected into our stamp');
    assert.doesNotMatch(ar, /header\.d=bank\.test/, 'the forged aligned-domain claim did not survive');
  } finally {
    await server.close();
  }
});

test('a HELO name carrying AR delimiters cannot forge a method result (null return-path path)', async () => {
  const server = await startServer(CONFIG);
  try {
    // Null return-path <> makes the SPF identity fall back to HELO, which is also
    // attacker-chosen; pack it with a forged spf=pass.
    await deliverWithEnvelope(server.inbound.port, 'evil.test;spf=pass', '');
    assert.equal(readMessages(server.mailbox).length, 1);
    const ar = ourAr(readMessages(server.mailbox)[0]!.raw.toString('latin1'));
    assert.doesNotMatch(ar, /spf=pass/, 'no forged spf=pass is injected via HELO');
  } finally {
    await server.close();
  }
});

test('a forged Authentication-Results in a SUBMITTED message is stripped, as on the inbound path', async () => {
  // RFC 8601 §5 stripping was wired to the inbound handler only. Submission is the WEAKER of the
  // two paths for this, not the stronger: inbound prepends our own genuine result above a forgery,
  // so a topmost-wins consumer still reads ours, whereas nothing is stamped on top here — a forged
  // result would reach the recipient as the ONLY Authentication-Results under our own identity.
  // One authenticated account (or one leaked app password) is enough to send it to any local user.
  const server = await startServer(CONFIG);
  try {
    const forged = 'Authentication-Results: mail.example.test; dkim=pass header.d=yourbank.test; dmarc=pass';
    const upstream = 'Authentication-Results: relay.upstream.test; dkim=pass header.d=elsewhere.test';
    // Submission is plaintext with a mandatory STARTTLS upgrade, not implicit TLS.
    const raw = net.connect(server.submission.port, '127.0.0.1');
    raw.on('error', () => {});
    let acc = '';
    const attach = (s: net.Socket | tls.TLSSocket): void => {
      s.on('data', (d: Buffer) => (acc += d.toString('latin1')));
    };
    const until = async (needle: string): Promise<void> => {
      for (let i = 0; i < 400; i++) {
        if (acc.includes(needle)) { acc = ''; return; }
        await delay(5);
      }
      throw new Error(`timed out on ${needle}: ${acc}`);
    };
    attach(raw);
    await until('ESMTP');
    raw.write('EHLO thunderbird\r\n');
    await until('250 ');
    raw.write('STARTTLS\r\n');
    await until('220 ');
    const sock = tls.connect({ socket: raw, rejectUnauthorized: false });
    sock.on('error', () => {});
    attach(sock);
    await new Promise<void>((r) => sock.once('secureConnect', () => r()));
    sock.write('EHLO thunderbird\r\n');
    await until('250 ');
    sock.write(`AUTH PLAIN ${Buffer.from('\0you\0pw', 'latin1').toString('base64')}\r\n`);
    await until('235');
    sock.write('MAIL FROM:<you@mail.example.test>\r\n');
    await until('250 ');
    sock.write('RCPT TO:<you@mail.example.test>\r\n');
    await until('250 ');
    sock.write('DATA\r\n');
    await until('354');
    sock.write(`From: you@mail.example.test\r\n${forged}\r\n${upstream}\r\nSubject: hi\r\n\r\nbody\r\n.\r\n`);
    await until('250 ');
    sock.end();

    const stored = readMessages(server.mailbox)
      .map((m) => m.raw.toString('latin1'))
      .join('\r\n');
    assert.doesNotMatch(stored, /dkim=pass header\.d=yourbank\.test/, 'the forgery under our authserv-id is stripped');
    // Control: a genuinely different authserv-id is an upstream result and must be preserved.
    assert.match(stored, /relay\.upstream\.test/, 'an upstream Authentication-Results survives');
  } finally {
    await server.close();
  }
});
