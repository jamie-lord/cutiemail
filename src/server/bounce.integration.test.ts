/**
 * End-to-end bounce (RFC 5321 §6.1): when a submitted message is permanently rejected
 * by the recipient's MX, the daemon must return a non-delivery report to the sender.
 * Here the sender is local, so the bounce lands in their own INBOX. Proves the relay
 * loop's onBounce is wired through main.ts to real local delivery.
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
const plainToken = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

/** A minimal MX that rejects every recipient with a permanent 550. */
async function rejectingMx(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('220 reject.example ESMTP\r\n');
    sock.on('data', (d) => {
      for (const line of d.toString('latin1').split('\r\n')) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 reject.example\r\n');
        else if (cmd === 'MAIL') sock.write('250 2.1.0 Ok\r\n');
        else if (cmd === 'RCPT') sock.write('550 5.1.1 no such user here\r\n');
        else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('a permanently-rejected submission bounces to the local sender INBOX', async () => {
  const mx = await rejectingMx();
  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'alice', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: mx.port },
    relayIntervalMs: 50,
  };
  const server = await startServer(config);
  try {
    const raw = net.connect(server.submission.port, '127.0.0.1');
    raw.on('error', () => {});
    const read = (): Promise<string> =>
      new Promise((res) => {
        raw.once('data', (d) => res(d.toString('latin1')));
      });
    await read(); // greeting
    raw.write('EHLO t\r\n');
    await read();
    raw.write('STARTTLS\r\n');
    await read();
    const sec = tls.connect({ socket: raw, rejectUnauthorized: false });
    sec.on('error', () => {});
    await new Promise<void>((r) => sec.once('secureConnect', () => r()));
    const sread = (): Promise<string> =>
      new Promise((res) => {
        sec.once('data', (d) => res(d.toString('latin1')));
      });
    sec.write('EHLO t\r\n');
    await sread();
    sec.write(`AUTH PLAIN ${plainToken('alice', 'pw')}\r\n`);
    await sread();
    sec.write('MAIL FROM:<alice@mail.example.test>\r\n');
    await sread();
    sec.write('RCPT TO:<nobody@remote.example>\r\n'); // remote, will be rejected
    await sread();
    sec.write('DATA\r\n');
    await sread();
    sec.write('Subject: will bounce\r\n\r\nthis cannot be delivered\r\n.\r\n');
    await sread();
    sec.end();

    // The relay attempts delivery, is rejected 550, and bounces to alice's INBOX.
    for (let i = 0; i < 200 && readMessages(server.mailbox).length === 0; i++) await delay(25);
    assert.equal(readMessages(server.mailbox).length, 1, 'a bounce was delivered to the local sender');
    const bounce = readMessages(server.mailbox)[0]!.raw.toString('latin1');
    assert.match(bounce, /From: Mail Delivery System <MAILER-DAEMON@mail\.example\.test>/, 'the bounce is from MAILER-DAEMON');
    assert.match(bounce, /multipart\/report; report-type=delivery-status/, 'it is a delivery-status report');
    assert.match(bounce, /Final-Recipient: rfc822; nobody@remote\.example/, 'it names the failed recipient');
    assert.match(bounce, /this cannot be delivered/, 'it returns the original message');
  } finally {
    await server.close();
    await mx.close();
  }
});
