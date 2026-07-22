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
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); }, {
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

test('submission: AUTH is refused DURING a mail transaction (RFC 4954 §4, R-4954-4-a)', async () => {
  // Reproduce-first: before the receiver deferred to canAuth (auth-state.ts) it had NO
  // mid-transaction guard, so this AUTH would have parsed and returned 235. requireAuth
  // is OFF here so a transaction can open BEFORE authentication, which isolates the
  // mid-transaction rule from the no-reauth rule (both otherwise answer 503).
  const accounts = new AccountStore();
  accounts.setPassword('alice', 'correct horse', Buffer.from('saltsalt'), 4096, 'sha256');
  const receiver = await SmtpReceiver.start(() => {}, {
    tls: { key: TEST_KEY, cert: TEST_CERT },
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
    // Open a transaction, THEN attempt AUTH; which must be refused mid-transaction.
    secure.write('MAIL FROM:<alice@example.com>\r\n');
    await sr.line('2.1.0 Ok\r\n');
    secure.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('503 5.5.1 AUTH not permitted during a mail transaction\r\n');
    secure.end();
  } finally {
    await receiver.close();
  }
});

test('submission: unsupported AUTH mechanisms are 504, a second AUTH after success is 503, and SASL cancel is 501 with the session surviving', async () => {
  const accounts = new AccountStore();
  accounts.setPassword('alice', 'correct horse', Buffer.from('saltsalt'), 4096, 'sha256');
  const receiver = await SmtpReceiver.start(() => {}, {
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

    // The only mechanisms offered are SCRAM/PLAIN over TLS (ADR 0007). LOGIN and
    // CRAM-MD5 are the executable proof of that cut: both draw 504 5.5.4.
    secure.write('AUTH LOGIN\r\n');
    await sr.line('504 5.5.4');
    secure.write('AUTH CRAM-MD5\r\n');
    await sr.line('504 5.5.4');

    // SASL cancel: AUTH PLAIN with no initial response -> 334, cancel with a bare '*'
    // -> 501 5.7.0, and the session survives (a real AUTH still works afterwards).
    secure.write('AUTH PLAIN\r\n');
    await sr.line('334');
    secure.write('*\r\n');
    await sr.line('501 5.7.0 authentication cancelled\r\n');

    secure.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('235');
    // A second AUTH after success is refused 503 (no re-authentication, R-4954-4-b).
    secure.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('503 5.5.1 already authenticated\r\n');
    secure.end();
  } finally {
    await receiver.close();
  }
});

test('inbound (no submission AUTH configured): AUTH draws 504 5.5.4 AUTH not supported', async () => {
  const receiver = await SmtpReceiver.start(() => {});
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.line('ESMTP\r\n');
    raw.write('EHLO client\r\n');
    await rr.line('250 8BITMIME\r\n'); // no AUTH advertised on the inbound port
    raw.write('AUTH PLAIN ' + plainToken('x', 'y') + '\r\n');
    await rr.line('504 5.5.4 AUTH not supported\r\n');
    raw.end();
  } finally {
    await receiver.close();
  }
});

test('submission: AUTH PLAIN two-step continuation form (RFC 4954) is supported', async () => {
  const accounts = new AccountStore();
  accounts.setPassword('alice', 'correct horse', Buffer.from('saltsalt'), 4096, 'sha256');
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); }, {
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
