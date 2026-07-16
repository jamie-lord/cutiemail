/**
 * IMAP mutation over the wire: a client marks a message \Seen with STORE, then
 * \Deleted, then EXPUNGE removes it — driving the live IMAP server against the real
 * SQLite mailbox. This wires the mailbox model's flag/EXPUNGE semantics through the
 * IMAP command surface, so the read leg supports the mutations a real client makes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ImapServer } from './imap-server.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Client {
  #acc = Buffer.alloc(0);
  readonly #sock: net.Socket;
  constructor(port: number) {
    this.#sock = net.connect(port, '127.0.0.1');
    this.#sock.on('data', (d) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    this.#sock.on('error', () => {});
  }
  async expect(needle: string): Promise<string> {
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(n);
      if (at !== -1) {
        const consumed = this.#acc.subarray(0, at + n.length).toString('latin1');
        this.#acc = this.#acc.subarray(at + n.length);
        return consumed;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
  send(line: string): void {
    this.#sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
  }
  end(): void {
    this.#sock.end();
  }
}

test('IMAP STORE marks flags and EXPUNGE removes \\Deleted messages', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('Subject: one\r\n\r\nbody one\r\n', 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN user pass');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('* 1 EXISTS');
    await c.expect('a2 OK');

    // Mark \Seen.
    c.send('a3 STORE 1 +FLAGS (\\Seen)');
    const stored = await c.expect('a3 OK');
    assert.ok(stored.includes('\\Seen'), 'the STORE response shows the new flag');
    assert.ok(mailbox.messages[0]!.flags.has('\\Seen'), 'the flag is persisted in storage');

    // Mark \Deleted, then EXPUNGE.
    c.send('a4 STORE 1 +FLAGS (\\Deleted)');
    await c.expect('a4 OK');
    c.send('a5 EXPUNGE');
    const expunged = await c.expect('a5 OK');
    assert.ok(expunged.includes('* 1 EXPUNGE'), 'the message is expunged');
    assert.equal(mailbox.messages.length, 0, 'storage is empty after EXPUNGE');

    // A fresh SELECT reflects the empty mailbox.
    c.send('a6 SELECT INBOX');
    await c.expect('* 0 EXISTS');
    await c.expect('a6 OK');
    c.send('a7 LOGOUT');
    c.end();
  } finally {
    await imap.close();
    db.close();
  }
});
