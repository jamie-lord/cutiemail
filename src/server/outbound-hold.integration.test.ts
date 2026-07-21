/**
 * MAIL_OUTBOUND=hold — the dev/test sink mode (ADR 0020, UX pressure-test finding).
 *
 * Without it, a dev/staging instance fed real-looking fixture addresses genuinely emails
 * them: authenticated submission to any external domain queues for real MX relay with days
 * of retries. In hold mode everything up to the queue behaves identically (authz, DKIM,
 * durable enqueue) but no byte may leave for a remote MX. The negative control proves the
 * same configuration WITHOUT hold does relay — so the assertion "the MX saw nothing" is
 * shown capable of failing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer, type MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mail.example.test';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plainToken = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

/** A capture MX that accepts everything and counts connections + stored messages. */
async function captureMx(): Promise<{ port: number; connections: () => number; messages: () => number; close: () => Promise<void> }> {
  let conns = 0;
  let msgs = 0;
  const server = net.createServer((sock) => {
    conns++;
    sock.on('error', () => {});
    sock.write('220 capture.example ESMTP\r\n');
    let inData = false;
    let dataAcc = '';
    sock.on('data', (d) => {
      const text = d.toString('latin1');
      if (inData) {
        // The dot terminator can arrive in its own chunk — accumulate across chunks.
        dataAcc += text;
        if (dataAcc.includes('\r\n.\r\n') || dataAcc === '.\r\n' || dataAcc.startsWith('.\r\n')) {
          inData = false;
          dataAcc = '';
          msgs++;
          sock.write('250 2.0.0 stored\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n')) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 capture.example\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') sock.write('250 Ok\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, connections: () => conns, messages: () => msgs, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Authenticated submission of one message to a REMOTE recipient; returns the final reply. */
async function submitRemote(port: number): Promise<string> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const readUntil = (sock: NodeJS.ReadableStream, needle: string): Promise<void> =>
    new Promise((res, rej) => {
      let acc = '';
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${needle} (saw ${JSON.stringify(acc)})`)), 3000);
      sock.on('data', (d: Buffer) => {
        acc += d.toString('latin1');
        if (acc.includes(needle)) {
          clearTimeout(t);
          res();
        }
      });
    });
  const first = readUntil(raw, 'ESMTP\r\n');
  await first;
  raw.write('EHLO dev.example\r\n');
  await readUntil(raw, '250 STARTTLS\r\n');
  raw.write('STARTTLS\r\n');
  await readUntil(raw, 'Ready to start TLS\r\n');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  let acc = '';
  secure.on('data', (d: Buffer) => (acc += d.toString('latin1')));
  const step = async (cmd: string, expect: RegExp): Promise<void> => {
    acc = '';
    secure.write(cmd);
    for (let i = 0; i < 400; i++) {
      if (expect.test(acc)) return;
      await delay(5);
    }
    throw new Error(`timeout on ${JSON.stringify(cmd)} (saw ${JSON.stringify(acc)})`);
  };
  await step('EHLO dev.example\r\n', /250 AUTH PLAIN\r\n/);
  await step(`AUTH PLAIN ${plainToken('alice', 'pw-alice')}\r\n`, /235 /);
  await step(`MAIL FROM:<alice@${DOMAIN}>\r\n`, /250 /);
  await step('RCPT TO:<customer@real-company.example>\r\n', /250 /);
  await step('DATA\r\n', /354 /);
  acc = '';
  secure.write(`From: alice@${DOMAIN}\r\nTo: customer@real-company.example\r\nSubject: fixture\r\n\r\ntest run\r\n.\r\n`);
  for (let i = 0; i < 400 && !/\d{3} /.test(acc); i++) await delay(5);
  const reply = acc;
  secure.end();
  return reply;
}

function config(mxPort: number, mode: 'deliver' | 'hold'): MailServerConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: DOMAIN,
    accounts: [{ user: 'alice', pass: 'pw-alice' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: mxPort },
    relayIntervalMs: 50,
    outboundMode: mode,
  };
}

test('hold mode: a remote submission is accepted and queued but NOTHING reaches the MX', async () => {
  const mx = await captureMx();
  const server = await startServer(config(mx.port, 'hold'));
  try {
    assert.match(await submitRemote(server.submission.port), /250 /, 'submission is accepted normally');
    assert.equal(server.queue.size, 1, 'the message is durably queued');
    // Give any (buggy) relay tick ample time to fire before asserting silence.
    await delay(300);
    assert.equal(mx.connections(), 0, 'no connection ever left for the MX');
    assert.equal(server.queue.size, 1, 'still held after the would-be relay interval');
  } finally {
    await server.close();
    await mx.close();
  }
});

test('negative control: the same config with deliver mode DOES reach the MX', async () => {
  const mx = await captureMx();
  const server = await startServer(config(mx.port, 'deliver'));
  try {
    assert.match(await submitRemote(server.submission.port), /250 /);
    for (let i = 0; i < 400 && mx.messages() === 0; i++) await delay(5);
    assert.equal(mx.messages(), 1, 'deliver mode relays — proving the hold assertion can fail');
  } finally {
    await server.close();
    await mx.close();
  }
});
