/**
 * Durability: a message delivered via SMTP survives a full server + database
 * restart and is still readable via IMAP. This is the property that makes a
 * SQLite-backed server trustworthy — deliver, tear everything down (server and DB
 * connection), reopen the same database file, and the message (and its UID
 * bookkeeping) is still there, byte-exact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { ImapServer } from './imap-server.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchFirstBody(port: number): Promise<Buffer> {
  const sock = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  const all = (): Buffer => Buffer.concat(chunks);
  const waitFor = async (needle: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (all().includes(Buffer.from(needle, 'latin1'))) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${needle}`);
  };
  await waitFor('* OK');
  sock.write(Buffer.from('a1 LOGIN user pass\r\na2 SELECT INBOX\r\n', 'latin1'));
  await waitFor('a2 OK');
  const before = all().length;
  sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
  await waitFor('a3 OK');
  const resp = all().subarray(before);
  const marker = /\{(\d+)\}\r\n/.exec(resp.toString('latin1'))!;
  const start = resp.indexOf(Buffer.from(marker[0], 'latin1')) + marker[0].length;
  sock.end();
  return Buffer.from(resp.subarray(start, start + Number(marker[1])));
}

test('durability: a delivered message survives a server + database restart', async () => {
  const dbPath = join(tmpdir(), `maildb-${randomUUID()}.db`);
  const data = Buffer.from('Subject: durable\r\n\r\nthis must survive a restart\r\n', 'latin1');
  try {
    // --- First run: deliver a message, then tear everything down. ---
    {
      const db = new DatabaseSync(dbPath);
      const mailbox = SqliteMailbox.open(db, 99);
      const smtp = await SmtpReceiver.start((m) => { mailbox.append(m.data); });
      const sent = await deliver(
        { host: '127.0.0.1', port: smtp.port, tls: 'none' },
        { from: 'a@example.com', recipients: ['b@example.net'], data, clientName: 'c.example.org' },
      );
      assert.ok(sent.ok, 'delivery should succeed');
      await smtp.close();
      db.close(); // close the database connection entirely
    }

    // --- Second run: reopen the SAME database file, serve IMAP, read it back. ---
    {
      const db = new DatabaseSync(dbPath);
      const mailbox = SqliteMailbox.open(db, 99);
      assert.equal(mailbox.messages.length, 1, 'the message persisted across the restart');
      assert.equal(mailbox.uidNext, 2, 'UID bookkeeping persisted (no reuse after restart)');
      const imap = await ImapServer.start(mailbox);
      try {
        const fetched = await fetchFirstBody(imap.port);
        assert.deepEqual(fetched, data, 'the message reads back byte-exact after the restart');
      } finally {
        await imap.close();
        db.close();
      }
    }
  } finally {
    rmSync(dbPath, { force: true });
  }
});
