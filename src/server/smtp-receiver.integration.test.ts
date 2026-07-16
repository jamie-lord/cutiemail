/**
 * End-to-end: the reference delivery client → the live SMTP receiver → SQLite
 * storage. The first slice of the runnable server assembled entirely from pieces
 * the test bed already specifies and validates: deliver() speaks real SMTP over a
 * socket to SmtpReceiver, which un-stuffs the DATA and stores it in a SqliteMailbox.
 * The message must arrive byte-exact, including the dot-stuffing round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';

const connectTo = (port: number): { host: string; port: number; tls: 'none' } => ({ host: '127.0.0.1', port, tls: 'none' });

test('e2e: a message delivered by the client lands byte-exact in SQLite storage', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const receiver = await SmtpReceiver.start((msg) => mailbox.append(msg.data));
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

test('e2e: the dot-stuffing round-trip is transparent (a leading-dot line survives)', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const receiver = await SmtpReceiver.start((msg) => mailbox.append(msg.data));
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
