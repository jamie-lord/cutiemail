/**
 * End-to-end: the reference delivery client → the live SMTP receiver → SQLite
 * storage. The first slice of the runnable server assembled entirely from pieces
 * the test bed already specifies and validates: deliver() speaks real SMTP over a
 * socket to SmtpReceiver, which un-stuffs the DATA and stores it in a SqliteMailbox.
 * The message must arrive byte-exact, including the dot-stuffing round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';

const connectTo = (port: number): { host: string; port: number; tls: 'none' } => ({ host: '127.0.0.1', port, tls: 'none' });

test('e2e: a message delivered by the client lands byte-exact in SQLite storage', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const receiver = await SmtpReceiver.start((msg) => { mailbox.append(msg.data); });
  try {
    const data = Buffer.from('Subject: hello\r\n\r\ndelivered through the live server\r\n', 'latin1');
    const result = await deliver(connectTo(receiver.port), {
      from: 'alice@example.com',
      recipients: ['bob@example.net'],
      data,
      clientName: 'client.example.org',
    });
    assert.ok(result.ok, `delivery should succeed: ${result.failure}`);
    // By the time deliver() returns (after the 250), the handler has stored it.
    assert.equal(mailbox.messages.length, 1);
    assert.deepEqual(mailbox.messages[0]!.raw, data, 'the stored bytes equal what was sent');
    assert.equal(mailbox.uidNext, 2, 'the UID was assigned and is not reusable');
  } finally {
    await receiver.close();
    db.close();
  }
});

test('receiver keeps the message final CRLF (RFC 5321 §4.1.1.4), matching aiosmtpd', async () => {
  // The first <CRLF> of the terminating <CRLF>.<CRLF> is also the one ending the
  // message's final line, so it must remain part of the stored bytes. Ground-truthed
  // against aiosmtpd, which stores "...Body\r\n" for a "...Body\r\n.\r\n" DATA stream.
  const cases: Array<{ wire: string; stored: string; note: string }> = [
    { wire: 'Subject: hi\r\n\r\nBody\r\n.\r\n', stored: 'Subject: hi\r\n\r\nBody\r\n', note: 'normal message keeps its final CRLF' },
    { wire: '.\r\n', stored: '', note: 'the bare-dot no-data case is empty' },
    { wire: '\r\n.\r\n', stored: '\r\n', note: 'a single empty line is one CRLF' },
    { wire: '..\r\n.\r\n', stored: '.\r\n', note: 'a line that is just a dot survives (stuffed ".." -> ".")' },
  ];
  for (const c of cases) {
    let stored: Buffer | null = null;
    const receiver = await SmtpReceiver.start((msg) => { stored = Buffer.from(msg.data); });
    try {
      const sock = net.connect(receiver.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', () => r()));
      const acc: Buffer[] = [];
      sock.on('data', (d) => acc.push(Buffer.from(d)));
      sock.on('error', () => {});
      const step = (s: string): Promise<void> =>
        new Promise((r) => {
          sock.write(Buffer.from(s, 'latin1'));
          setTimeout(r, 25);
        });
      await step('');
      await step('EHLO t\r\n');
      await step('MAIL FROM:<a@example.com>\r\n');
      await step('RCPT TO:<b@example.net>\r\n');
      await step('DATA\r\n');
      await step(c.wire);
      assert.deepEqual((stored as Buffer | null)?.toString('latin1'), c.stored, c.note);
      sock.destroy();
    } finally {
      await receiver.close();
    }
  }
});

test('e2e: the dot-stuffing round-trip is transparent (a leading-dot line survives)', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const receiver = await SmtpReceiver.start((msg) => { mailbox.append(msg.data); });
  try {
    // A body line that begins with a dot — the client stuffs it, the server unstuffs it.
    const data = Buffer.from('Subject: dots\r\n\r\n.a line starting with a dot\r\n..two dots\r\n', 'latin1');
    const result = await deliver(connectTo(receiver.port), {
      from: 'a@example.com',
      recipients: ['b@example.net'],
      data,
      clientName: 'c.example.org',
    });
    assert.ok(result.ok, `delivery should succeed: ${result.failure}`);
    assert.deepEqual(mailbox.messages[0]!.raw, data, 'the leading-dot lines survive the stuff/unstuff round-trip');
  } finally {
    await receiver.close();
    db.close();
  }
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A raw line-based SMTP client for adversarial cases the reference client won't send. */
class RawSmtp {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(port: number) {
    this.sock = net.connect(port, '127.0.0.1');
    this.sock.on('data', (d) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    this.sock.on('error', () => {});
  }
  write(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  async expect(code: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      // Match a reply line starting with the code (most recent occurrence).
      const idx = s.lastIndexOf(`\n${code}`);
      if (s.startsWith(code) || idx >= 0) return s;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${code} in ${JSON.stringify(this.#acc.toString('latin1'))}`);
  }
}

test('the receiver caps recipients per transaction (452), resisting unbounded RCPT DoS', async () => {
  const receiver = await SmtpReceiver.start(() => {});
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    c.write('EHLO probe\r\n');
    await c.expect('250');
    c.write('MAIL FROM:<a@b.test>\r\n');
    await c.expect('250');
    // 100 recipients are accepted...
    for (let i = 0; i < 100; i++) {
      c.write(`RCPT TO:<u${i}@x.test>\r\n`);
      await c.expect('250');
    }
    // ...the 101st is refused with a transient 452, and the connection survives.
    c.write('RCPT TO:<overflow@x.test>\r\n');
    const resp = await c.expect('452');
    assert.match(resp, /452/, 'the recipient over the cap is rejected with 452');
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});

test('a single transaction carries every accepted recipient, in order (multi-RCPT)', async () => {
  // The receiver hands the delivery handler ALL accepted recipients on one message.
  // (The daemon-level fan-out to two separate mailboxes is main.ts's responsibility,
  // covered by the daemon integration tests; here we pin the receiver's recipient list.)
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); });
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    c.write('EHLO probe\r\n');
    await c.expect('250');
    c.write('MAIL FROM:<a@b.test>\r\n');
    await c.expect('250 2.1.0 Ok');
    c.write('RCPT TO:<first@x.test>\r\n');
    await c.expect('250 2.1.5 Ok');
    c.write('RCPT TO:<second@x.test>\r\n');
    await c.expect('250 2.1.5 Ok');
    c.write('DATA\r\n');
    await c.expect('354');
    c.write('Subject: fan-out\r\n\r\none body, two recipients\r\n.\r\n');
    await c.expect('250 2.0.0 message stored');
    assert.equal(delivered.length, 1, 'one message delivered');
    assert.deepEqual(delivered[0]!.recipients, ['first@x.test', 'second@x.test'], 'both recipients carried, in order');
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});

test('DATA before any RCPT is refused 503, and a normal transaction still completes afterwards', async () => {
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); });
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    c.write('EHLO probe\r\n');
    await c.expect('250');
    // DATA with no recipient buffered is out of order (RFC 5321 §4.1.4) -> 503.
    c.write('DATA\r\n');
    const r = await c.expect('503');
    assert.match(r, /503 5\.5\.1 need RCPT/, 'DATA before RCPT draws 503');
    // The connection survives: a full transaction still completes on it.
    c.write('MAIL FROM:<a@b.test>\r\n');
    await c.expect('250 2.1.0 Ok');
    c.write('RCPT TO:<u@x.test>\r\n');
    await c.expect('250 2.1.5 Ok');
    c.write('DATA\r\n');
    await c.expect('354');
    c.write('Subject: recovered\r\n\r\nbody\r\n.\r\n');
    await c.expect('250 2.0.0 message stored');
    assert.equal(delivered.length, 1, 'the subsequent normal transaction delivered');
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});

test('HELO draws a single-line 250 and a full transaction works; a mid-transaction NOOP does not disturb it', async () => {
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); });
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    // HELO (not EHLO): the fallback greeting. It MUST draw a single-line 250, never
    // an EHLO-style extension list (RFC 5321 §3.2).
    c.write('HELO client\r\n');
    const helo = await c.expect('250');
    assert.ok(!helo.includes('250-'), 'HELO draws a single-line 250, never a continued (250-) extension list');
    c.write('MAIL FROM:<a@b.test>\r\n');
    await c.expect('250 2.1.0 Ok');
    // NOOP mid-transaction must not forget the reverse-path (RFC 5321 §4.1.1.9).
    c.write('NOOP\r\n');
    await c.expect('250 2.0.0 Ok');
    c.write('RCPT TO:<u@x.test>\r\n');
    await c.expect('250 2.1.5 Ok');
    c.write('DATA\r\n');
    await c.expect('354');
    c.write('Subject: helo path\r\n\r\nbody\r\n.\r\n');
    await c.expect('250 2.0.0 message stored');
    assert.equal(delivered.length, 1, 'the HELO-opened, NOOP-spanning transaction delivered');
    assert.deepEqual(delivered[0]!.recipients, ['u@x.test']);
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});

test('a non-ASCII (UTF-8) envelope address is failed 553 (SMTPUTF8 not offered); ASCII still delivers', async () => {
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); });
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    c.write('EHLO probe\r\n');
    const ehlo = await c.expect('250');
    assert.ok(!ehlo.includes('SMTPUTF8'), 'the receiver does not advertise SMTPUTF8');
    // A UTF-8 local-part in MAIL FROM, as raw UTF-8 octets on the wire. Without
    // SMTPUTF8 the envelope must stay ASCII, so this is failed, not silently accepted.
    c.sock.write(Buffer.from('MAIL FROM:<náïve@example.com>\r\n', 'utf8'));
    const mail = await c.expect('553');
    assert.match(mail, /553 5\.6\.7/, 'non-ASCII reverse-path failed 553 5.6.7');
    // An ASCII sender works; a non-ASCII recipient in that transaction is likewise failed.
    c.write('MAIL FROM:<ascii@example.com>\r\n');
    await c.expect('250 2.1.0 Ok');
    c.sock.write(Buffer.from('RCPT TO:<bòb@example.net>\r\n', 'utf8'));
    await c.expect('553');
    // ...and an ASCII recipient in the same transaction still delivers.
    c.write('RCPT TO:<bob@example.net>\r\n');
    await c.expect('250 2.1.5 Ok');
    c.write('DATA\r\n');
    await c.expect('354');
    c.write('Subject: ascii ok\r\n\r\nbody\r\n.\r\n');
    await c.expect('250 2.0.0 message stored');
    assert.equal(delivered.length, 1, 'the all-ASCII transaction delivered');
    assert.deepEqual(delivered[0]!.recipients, ['bob@example.net'], 'only the ASCII recipient was buffered');
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});

test('a DATA terminator split across many tiny chunks is still detected (resume-offset scan)', async () => {
  let stored: Buffer | null = null;
  const receiver = await SmtpReceiver.start((msg) => { stored = Buffer.from(msg.data); });
  const c = new RawSmtp(receiver.port);
  try {
    await c.expect('220');
    c.write('EHLO probe\r\n');
    await c.expect('250');
    c.write('MAIL FROM:<a@b.test>\r\n');
    await c.expect('250');
    c.write('RCPT TO:<u@x.test>\r\n');
    await c.expect('250');
    c.write('DATA\r\n');
    await c.expect('354');
    // Stream the whole DATA — including the CRLF.CRLF terminator — one byte per chunk,
    // so the terminator straddles chunk boundaries and the resume offset must overlap.
    const payload = 'Subject: split\r\n\r\nline one\r\nline two\r\n.\r\n';
    for (const ch of payload) {
      c.write(ch);
      await delay(1);
    }
    await c.expect('250');
    assert.ok(stored !== null, 'the message was stored despite the byte-at-a-time terminator');
    assert.equal((stored as unknown as Buffer).toString('latin1'), 'Subject: split\r\n\r\nline one\r\nline two\r\n', 'stored byte-exact, terminator stripped');
    c.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
    await receiver.close();
  }
});
