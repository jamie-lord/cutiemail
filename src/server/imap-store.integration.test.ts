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

test('an unrecognized STORE operation is rejected with BAD, not answered OK', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('Subject: one\r\n\r\nx\r\n', 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN u p');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');
    // A typo'd operator must not be silently accepted as a successful no-op store.
    c.send('a3 STORE 1 XFLAGS (\\Seen)');
    const resp = await c.expect('a3 BAD');
    assert.match(resp, /a3 BAD/, 'a bogus STORE op is a protocol error, not OK');
    assert.ok(!mailbox.messages[0]!.flags.has('\\Seen'), 'nothing was stored');
    // The connection is still usable after the rejection.
    c.send('a4 NOOP');
    await c.expect('a4 OK');
  } finally {
    await imap.close();
    db.close();
  }
});

test('a failed SELECT deselects — a subsequent EXPUNGE reports no mailbox selected (RFC 9051 §6.3.2)', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('Subject: one\r\n\r\nx\r\n', 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN u p');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');
    // A failed SELECT must leave NO mailbox selected, not the previous one.
    c.send('a3 SELECT "No Such Box"');
    await c.expect('a3 NO');
    c.send('a4 EXPUNGE');
    const resp = await c.expect('a4 BAD no mailbox selected');
    assert.match(resp, /a4 BAD no mailbox selected/, 'after a failed SELECT the session holds no mailbox');
  } finally {
    await imap.close();
    db.close();
  }
});

test('STORE preserves "$" keyword flags ($label1, $Forwarded) — clients tag with these', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('Subject: m\r\n\r\nbody\r\n', 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN user pass');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');
    // Thunderbird tags and standard keywords carry a "$" prefix that must survive.
    c.send('a3 STORE 1 +FLAGS (\\Seen $Forwarded $label1)');
    const stored = await c.expect('a3 OK');
    assert.match(stored, /\$Forwarded/, 'the $ prefix is not stripped in the response');
    assert.match(stored, /\$label1/, 'a $labelN tag survives');
    const flags = new Set(mailbox.messages[0]!.flags);
    assert.ok(flags.has('$Forwarded') && flags.has('$label1') && flags.has('\\Seen'), 'all three are persisted verbatim');
  } finally {
    await imap.close();
    db.close();
  }
});

test('non-silent STORE reports the accurate resulting flag set for add/remove/replace', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('Subject: m\r\n\r\nbody\r\n', 'latin1'), ['\\Flagged']); // starts \Flagged
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN user pass');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');

    // +FLAGS merges with the existing \Flagged — the response must show BOTH.
    c.send('a3 STORE 1 +FLAGS (\\Seen)');
    const added = await c.expect('a3 OK');
    assert.match(added, /\* 1 FETCH \(FLAGS \(\\Flagged \\Seen\)\)/, 'add reports the union, not just the added flag');

    // -FLAGS removes just the named flag.
    c.send('a4 STORE 1 -FLAGS (\\Flagged)');
    const removed = await c.expect('a4 OK');
    assert.match(removed, /\* 1 FETCH \(FLAGS \(\\Seen\)\)/, 'remove reports the remaining flags');

    // Bare FLAGS replaces the whole set.
    c.send('a5 STORE 1 FLAGS (\\Answered)');
    const replaced = await c.expect('a5 OK');
    assert.match(replaced, /\* 1 FETCH \(FLAGS \(\\Answered\)\)/, 'replace reports exactly the new set');
    assert.deepEqual([...mailbox.messages[0]!.flags], ['\\Answered'], 'and persists exactly that set');

    // .SILENT suppresses the untagged FETCH entirely.
    c.send('a6 STORE 1 +FLAGS.SILENT (\\Seen)');
    const silent = await c.expect('a6 OK');
    assert.doesNotMatch(silent, /\* 1 FETCH/, 'a .SILENT store emits no untagged FETCH');
    assert.ok(mailbox.messages[0]!.flags.has('\\Seen'), 'but the flag is still persisted');

    c.send('a7 LOGOUT');
    c.end();
  } finally {
    await imap.close();
    db.close();
  }
});

test('system flags are case-insensitive: lowercase \\deleted stores as \\Deleted and EXPUNGE removes it (RFC 9051 §2.3.2)', async () => {
  // Dovecot's imaptest (and some clients) send flags in lower case. A server that
  // stored `\deleted` verbatim would never match it against `\Deleted` at EXPUNGE
  // time, silently leaving the message. STORE and APPEND must canonicalise system
  // flags.
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  for (const s of ['one', 'two', 'three']) mailbox.append(Buffer.from(`Subject: ${s}\r\n\r\nx\r\n`, 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN user pass');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');

    // Lower-case store is echoed canonicalised and persisted canonicalised.
    c.send('a3 STORE 2 FLAGS (\\deleted \\seen)');
    const stored = await c.expect('a3 OK');
    assert.match(stored, /\* 2 FETCH \(FLAGS \(\\Deleted \\Seen\)\)/, 'echoed in canonical case');
    assert.deepEqual(new Set(mailbox.messages[1]!.flags), new Set(['\\Deleted', '\\Seen']), 'persisted canonical');

    // EXPUNGE (which looks for \Deleted) now matches the lower-case-set flag.
    c.send('a4 EXPUNGE');
    const expunged = await c.expect('a4 OK');
    assert.match(expunged, /\* 2 EXPUNGE/, 'the lower-case-\\deleted message is expunged');
    assert.equal(mailbox.messages.length, 2, 'one message removed');
    assert.ok(!mailbox.messages.some((m) => [...m.flags].some((f) => f.toLowerCase() === '\\deleted')), 'no \\Deleted survivor');

    c.send('a5 LOGOUT');
    c.end();
  } finally {
    await imap.close();
    db.close();
  }
});
