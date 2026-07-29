/**
 * Connection lifecycle on the SMTP listeners: what happens after the server has decided a
 * session is over.
 *
 * Three defects lived in the gap between "we replied and called end()" and "we stopped
 * reading". `end()` is a HALF-close: it sends FIN but leaves the peer's write side open, so
 * anything that keeps accumulating after it accumulates without a peer we will ever answer.
 *
 *  - STARTTLS was gated on whether TLS is CONFIGURED, never on whether it is already ACTIVE,
 *    and each upgrade wraps the current socket, so one connection could nest TLSSocket objects
 *    until the stream machinery overflowed the call stack and took the process with it.
 *  - #onData appended each chunk to #buf BEFORE testing #ended, so a peer that kept its write
 *    side open after a 421 grew an unparsed buffer without bound.
 *  - QUIT ended the socket without setting #ended or returning, so pipelined commands after it
 *    still executed — and mail was accepted and stored while the peer had been told the session
 *    was over, so it never saw the acknowledgement.
 *
 * Each test drives a real listener over a real socket and asserts the observable the fix
 * changes, not an internal field.
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
  accounts: [{ user: 'you', pass: 'correct horse battery staple' }],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

/** Read from a socket until `needle` appears, or give up. Returns everything seen. */
async function readUntil(chunks: () => Buffer, needle: string, tries = 400): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const seen = chunks().toString('latin1');
    if (seen.includes(needle)) return seen;
    await delay(5);
  }
  return chunks().toString('latin1');
}

test('STARTTLS is refused once TLS is already active, so the socket cannot be nested', async () => {
  const server = await startServer(CONFIG);
  try {
    const raw = net.connect(server.inbound.port, '127.0.0.1');
    raw.on('error', () => {});
    let acc = Buffer.alloc(0);
    raw.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));

    await readUntil(() => acc, '220 ');
    acc = Buffer.alloc(0);
    raw.write('EHLO probe.test\r\n');
    await readUntil(() => acc, '250 ');
    acc = Buffer.alloc(0);
    raw.write('STARTTLS\r\n');
    await readUntil(() => acc, '220 ');

    // Upgrade for real, then ask again from inside the TLS stream.
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));

    let tlsAcc = Buffer.alloc(0);
    secure.on('data', (d) => (tlsAcc = Buffer.concat([tlsAcc, Buffer.from(d)])));
    secure.write('EHLO probe.test\r\n');
    await readUntil(() => tlsAcc, '250 ');
    tlsAcc = Buffer.alloc(0);
    secure.write('STARTTLS\r\n');
    const reply = await readUntil(() => tlsAcc, '\r\n');

    // The defect answered 220 and wrapped the TLSSocket in another TLSSocket. Fifty of those
    // overflowed the stack and killed the process, which serves IMAP and submission too.
    assert.ok(
      reply.includes('554'),
      `a second STARTTLS must be refused, got: ${JSON.stringify(reply)}`,
    );
    assert.ok(!reply.includes('220 2.0.0 Ready to start TLS'), 'must not offer another upgrade');
    secure.destroy();
  } finally {
    await server.close();
  }
});

test('a connection closed for protocol errors is destroyed, not left half-open', async () => {
  const server = await startServer(CONFIG);
  try {
    // allowHalfOpen keeps OUR write side open after the server's FIN — which is exactly what a
    // peer exploiting the half-close does. A default client auto-closes here and hides the bug.
    const sock = net.connect({ port: server.inbound.port, host: '127.0.0.1', allowHalfOpen: true });
    sock.on('error', () => {});
    let acc = Buffer.alloc(0);
    sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
    let closed = false;
    sock.on('close', () => (closed = true));

    await readUntil(() => acc, '220 ');
    for (let i = 0; i < 25; i++) sock.write('FROBNICATE junk\r\n');
    await readUntil(() => acc, '421 ');

    // Keep streaming. The defect concatenated every byte into #buf forever, so the connection
    // stayed alive and memory grew without bound.
    for (let i = 0; i < 64; i++) {
      sock.write(Buffer.alloc(64 * 1024, 0x41));
      await delay(1);
    }
    for (let i = 0; i < 200 && !closed; i++) await delay(5);

    assert.equal(closed, true, 'the server must destroy the socket, not hold it half-open');
    sock.destroy();
  } finally {
    await server.close();
  }
});

test('commands pipelined after QUIT are not executed', async () => {
  const server = await startServer(CONFIG);
  try {
    const before = readMessages(server.mailbox).length;
    const sock = net.connect(server.inbound.port, '127.0.0.1');
    sock.on('error', () => {});
    let acc = Buffer.alloc(0);
    sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
    await readUntil(() => acc, '220 ');

    // One write, so everything after QUIT is already buffered when QUIT is processed.
    sock.write(
      'EHLO probe.test\r\n' +
        'QUIT\r\n' +
        'MAIL FROM:<someone@elsewhere.test>\r\n' +
        'RCPT TO:<you@mail.example.test>\r\n' +
        'DATA\r\n' +
        'From: someone@elsewhere.test\r\n' +
        'Subject: AFTER-QUIT\r\n' +
        '\r\n' +
        'body\r\n' +
        '.\r\n',
    );
    await readUntil(() => acc, '221 ');
    await delay(150);

    const stored = readMessages(server.mailbox);
    assert.equal(
      stored.length,
      before,
      'nothing may be accepted after the peer was told the session ended',
    );
    assert.ok(
      !stored.some((m) => m.raw.toString('latin1').includes('AFTER-QUIT')),
      'the post-QUIT message must not be stored',
    );
    sock.destroy();
  } finally {
    await server.close();
  }
});

test('the mail-loop rejection ends the transaction, like its sibling exits from DATA', async () => {
  // §4.1.4 requires MAIL before RCPT. Every exit from DATA clears #inTransaction except this one,
  // so after a 554 a bare RCPT was answered 250 and the handler saw an empty reverse-path. Not an
  // authorization gain — the send-as gate and acceptRecipient still applied — but a state machine
  // that disagrees with itself on one branch is how the next defect gets in.
  const server = await startServer({ ...CONFIG, maxReceivedHops: 3 });
  try {
    const sock = net.connect(server.inbound.port, '127.0.0.1');
    sock.on('error', () => {});
    let acc = Buffer.alloc(0);
    sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
    await readUntil(() => acc, '220 ');

    sock.write('EHLO probe.test\r\n');
    await readUntil(() => acc, '250 ');
    sock.write('MAIL FROM:<a@b.test>\r\n');
    await readUntil(() => acc, '250 ');
    sock.write('RCPT TO:<you@mail.example.test>\r\n');
    await readUntil(() => acc, '250 ');
    acc = Buffer.alloc(0);
    sock.write(`DATA\r\n${'Received: from a by b\r\n'.repeat(5)}\r\nbody\r\n.\r\n`);
    await readUntil(() => acc, '554 ');

    acc = Buffer.alloc(0);
    sock.write('RCPT TO:<you@mail.example.test>\r\n');
    const reply = await readUntil(() => acc, '\r\n');
    assert.match(reply, /^503 /m, 'RCPT without MAIL FROM must be refused after the loop rejection');
    sock.destroy();
  } finally {
    await server.close();
  }
});
