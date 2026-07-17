/**
 * Submission AUTH end to end: the SMTP receiver in submission mode requires a
 * successful SASL PLAIN over TLS before it accepts mail, verifying credentials
 * against the SCRAM account store (which holds no passwords). Wires together the
 * receiver, STARTTLS, the account store, and the no-plaintext-AUTH rule (ADR 0007).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';
import { AccountStore } from '../store/accounts.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plainToken = (user: string, pass: string): string => Buffer.from(`\0${user}\0${pass}`, 'latin1').toString('base64');

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

test('submission: MAIL is refused until AUTH succeeds over TLS; wrong creds and plaintext AUTH are rejected', async () => {
  const accounts = new AccountStore();
  accounts.setPassword('alice', 'correct horse', Buffer.from('saltsalt'), 4096, 'sha256');

  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => delivered.push(m), {
    tls: { key: TEST_KEY, cert: TEST_CERT },
    requireAuth: true,
    authenticate: (u, p) => accounts.verifyPassword(u, p),
  });
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.line('ESMTP\r\n');
    raw.write('EHLO client\r\n');
    await rr.line('250 STARTTLS\r\n');

    // Plaintext AUTH is refused (no encryption yet).
    raw.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await rr.line('538');

    raw.write('STARTTLS\r\n');
    await rr.line('Ready to start TLS\r\n');
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));
    const sr = new Reader(secure);
    secure.write('EHLO client\r\n');
    await sr.line('250 AUTH PLAIN\r\n');

    // Not authenticated yet -> MAIL is refused.
    secure.write('MAIL FROM:<alice@example.com>\r\n');
    await sr.line('530 5.7.0 Authentication required\r\n');

    // Wrong password -> 535.
    secure.write('AUTH PLAIN ' + plainToken('alice', 'wrong') + '\r\n');
    await sr.line('535');

    // Correct password -> 235, then MAIL is accepted and a message delivers.
    secure.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('235');
    secure.write('MAIL FROM:<alice@example.com>\r\n');
    await sr.line('2.1.0 Ok\r\n');
    secure.write('RCPT TO:<bob@example.net>\r\n');
    await sr.line('2.1.5 Ok\r\n');
    secure.write('DATA\r\n');
    await sr.line('354');
    secure.write('Subject: authed\r\n\r\nsent after authentication\r\n.\r\n');
    await sr.line('message stored\r\n');
    secure.end();

    assert.equal(delivered.length, 1, 'exactly the authenticated message delivered');
    assert.ok(delivered[0]!.overTls && delivered[0]!.data.includes(Buffer.from('after authentication')));
  } finally {
    await receiver.close();
  }
});

test('submission: AUTH PLAIN two-step continuation form (RFC 4954) is supported', async () => {
  const accounts = new AccountStore();
  accounts.setPassword('alice', 'correct horse', Buffer.from('saltsalt'), 4096, 'sha256');
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => delivered.push(m), {
    tls: { key: TEST_KEY, cert: TEST_CERT },
    requireAuth: true,
    authenticate: (u, p) => accounts.verifyPassword(u, p),
  });
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.line('ESMTP\r\n');
    raw.write('EHLO client\r\n');
    await rr.line('250 STARTTLS\r\n');
    raw.write('STARTTLS\r\n');
    await rr.line('Ready to start TLS\r\n');
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));
    const sr = new Reader(secure);
    secure.write('EHLO client\r\n');
    await sr.line('250 AUTH PLAIN\r\n');

    // Two-step: AUTH PLAIN with no initial response -> 334 challenge -> credentials.
    secure.write('AUTH PLAIN\r\n');
    await sr.line('334');
    secure.write(plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('235');

    // Authenticated: MAIL is now accepted.
    secure.write('MAIL FROM:<alice@example.com>\r\n');
    await sr.line('2.1.0 Ok\r\n');
    secure.end();
  } finally {
    await receiver.close();
  }
});
