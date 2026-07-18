/**
 * The SQLite mailbox catalog: named folders in one database. Three things must
 * hold before this ships to the live box: folders persist across reopen, each
 * mailbox's UID sequence is independent, and — critically — a database created
 * BEFORE multi-mailbox existed (no name column, one implicit INBOX row) migrates
 * in place without losing the mail already stored in it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCatalog, SqliteMailbox } from './sqlite-mailbox.ts';

test('folders persist across close/reopen with their content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const path = join(dir, 'mail.db');
  try {
    const db = new DatabaseSync(path);
    const cat = SqliteCatalog.open(db);
    cat.create('Trash');
    cat.create('Sent');
    cat.get('Sent')!.append(Buffer.from('Subject: filed\r\n\r\nx\r\n', 'latin1'), ['\\Seen']);
    db.close();

    const db2 = new DatabaseSync(path);
    const cat2 = SqliteCatalog.open(db2);
    assert.deepEqual([...cat2.listNames()].sort(), ['INBOX', 'Sent', 'Trash']);
    const sent = cat2.get('Sent')!;
    assert.equal(sent.messages.length, 1);
    assert.ok(sent.messages[0]!.flags.has('\\Seen'));
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each mailbox has an independent UID sequence', () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  const inbox = cat.get('INBOX')!;
  const trash = cat.create('Trash')!;
  assert.equal(inbox.append(Buffer.from('a')), 1);
  assert.equal(inbox.append(Buffer.from('b')), 2);
  assert.equal(trash.append(Buffer.from('c')), 1, 'a new mailbox starts its own UIDs at 1');
  assert.equal(inbox.uidNext, 3);
  assert.equal(trash.uidNext, 2);
});

test('RENAME INBOX preserves highest_modseq and the expunge log (RFC 7162 invariant)', () => {
  // Audit run-2 finding 2: the INBOX-rename special case moved messages (keeping their
  // mod_seq) into a NEW mailbox row whose highest_modseq defaulted to 1 — violating
  // HIGHESTMODSEQ >= every message's MODSEQ and silently desyncing CONDSTORE/QRESYNC.
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  const inbox = cat.get('INBOX')!;
  const uid1 = inbox.append(Buffer.from('a'));
  inbox.append(Buffer.from('b'));
  inbox.storeFlags(uid1, 'add', ['\\Seen']); // bump modseq above 1
  inbox.expunge(uid1); // an entry in the expunge log to prove it moves
  const beforeModseq = inbox.highestModseq;
  assert.ok(beforeModseq > 1, 'precondition: modseq advanced past the default');

  assert.equal(cat.rename('INBOX', 'Foo'), 'ok');
  const foo = cat.get('Foo')!;
  // The invariant: HIGHESTMODSEQ carried over, NOT reset to 1 (negative control: the old
  // code left it at the column DEFAULT 1, below the moved messages' mod_seq).
  assert.equal(foo.highestModseq, beforeModseq, 'highest_modseq carried onto the renamed mailbox');
  // Monotonicity holds: a further change climbs above the carried value.
  const remaining = inbox === foo ? uid1 : 2;
  foo.storeFlags(remaining, 'add', ['\\Flagged']);
  assert.ok(foo.highestModseq > beforeModseq, 'a later change gets a higher modseq');
  // The expunge log moved with the messages (QRESYNC VANISHED history preserved).
  assert.ok(foo.expungedSince(1).includes(uid1), 'the pre-rename expunge is visible on the renamed mailbox');
});

test('RENAME INBOX reports the moved messages as VANISHED on the now-empty INBOX (run-7 QRESYNC)', () => {
  // The production path emptied INBOX but left its HIGHESTMODSEQ unchanged and its expunge log
  // empty, so a QRESYNC/CONDSTORE client reconnecting to INBOX was told "nothing changed" while
  // every cached message had silently moved out — a desync MemoryCatalog does not exhibit.
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  const inbox = cat.get('INBOX')!;
  for (const c of ['a', 'b', 'c']) inbox.append(Buffer.from(c)); // uid 1,2,3
  const beforeModseq = inbox.highestModseq;
  assert.equal(cat.rename('INBOX', 'Archive'), 'ok');
  const after = cat.get('INBOX')!;
  assert.equal(after.messages.length, 0, 'INBOX is emptied');
  assert.ok(after.highestModseq > beforeModseq, 'INBOX modseq is bumped so a client detects a change');
  assert.deepEqual(after.expungedSince(beforeModseq), [1, 2, 3], 'the moved messages are reported VANISHED on INBOX');
  assert.equal(cat.get('Archive')!.messages.length, 3, 'the messages landed in Archive');
});

test('DELETE clears the expunge tombstones so a reused mailbox id does not inherit them (run-7 QRESYNC)', () => {
  // create() reuses a freed internal id (MAX(id)+1); delete() must clear the expunge log or the
  // next mailbox reusing that id inherits the dead folder's tombstones — a QRESYNC client would
  // be told a LIVE message it just received had VANISHED. The MemoryCatalog oracle builds a fresh
  // log, so the suite was blind to this.
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  const foo = cat.create('Foo')!;
  foo.append(Buffer.from('a'));
  foo.append(Buffer.from('b'));
  foo.expunge(1);
  foo.expunge(2);
  assert.deepEqual(foo.expungedSince(0), [1, 2], 'precondition: Foo has tombstones');
  assert.equal(cat.delete('Foo'), true);
  const bar = cat.create('Bar')!; // reuses Foo's freed id
  assert.deepEqual(bar.expungedSince(0), [], 'a freshly created mailbox has no leaked tombstones');
  const uid = bar.append(Buffer.from('live'));
  assert.equal(bar.expungedSince(0).includes(uid), false, 'the live message it just received is not reported VANISHED');
});

test('INBOX matches case-insensitively; other names are exact; INBOX cannot be re-created', () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  assert.ok(cat.get('inbox') !== undefined);
  assert.equal(cat.create('Inbox'), undefined, 'any-case INBOX already exists');
  cat.create('Work');
  assert.equal(cat.get('work'), undefined, 'non-INBOX names are case-sensitive');
  assert.ok(cat.get('Work') !== undefined);
});

test('a pre-multi-mailbox database migrates in place, keeping its stored mail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  const path = join(dir, 'old.db');
  try {
    // Recreate the OLD schema exactly as SqliteMailbox wrote it before the name
    // column existed, with one message in the implicit single mailbox (id 1).
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE mailbox (id INTEGER PRIMARY KEY, uid_validity INTEGER NOT NULL, uid_next INTEGER NOT NULL);
      CREATE TABLE message (mailbox_id INTEGER NOT NULL, uid INTEGER NOT NULL, internal_date INTEGER NOT NULL, raw BLOB NOT NULL, PRIMARY KEY (mailbox_id, uid));
      CREATE TABLE flag (mailbox_id INTEGER NOT NULL, uid INTEGER NOT NULL, flag TEXT NOT NULL, PRIMARY KEY (mailbox_id, uid, flag));
      INSERT INTO mailbox (id, uid_validity, uid_next) VALUES (1, 1, 2);
    `);
    old.prepare('INSERT INTO message (mailbox_id, uid, internal_date, raw) VALUES (1, 1, 0, ?)').run(Buffer.from('Subject: old mail\r\n\r\nkept\r\n', 'latin1'));
    old.close();

    const db = new DatabaseSync(path);
    const cat = SqliteCatalog.open(db);
    assert.deepEqual(cat.listNames(), ['INBOX'], 'the legacy row becomes INBOX');
    const inbox = cat.get('INBOX')!;
    assert.equal(inbox.messages.length, 1, 'the stored mail survives migration');
    assert.ok(inbox.messages[0]!.raw.includes(Buffer.from('old mail')));
    assert.equal(inbox.uidNext, 2, 'UID bookkeeping is untouched');
    cat.create('Trash');
    assert.deepEqual([...cat.listNames()].sort(), ['INBOX', 'Trash'], 'new folders work after migration');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WAL journaling can be enabled on a file db and transactional writes persist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wal-'));
  const path = join(dir, 'mail.db');
  try {
    const db = new DatabaseSync(path);
    // Same enablement the daemon does.
    db.exec('PRAGMA journal_mode=WAL');
    const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    assert.equal(mode.toLowerCase(), 'wal', 'WAL mode is active on a file-backed db');

    const cat = SqliteCatalog.open(db);
    const inbox = cat.get('INBOX')!;
    const uid = inbox.append(Buffer.from('Subject: durable\r\n\r\nx\r\n', 'latin1'), ['\\Seen']);
    inbox.storeFlags(uid, 'add', ['\\Flagged']);
    db.close();

    // Reopen: the transactional append + flag write survived, atomically.
    const db2 = new DatabaseSync(path);
    const inbox2 = SqliteCatalog.open(db2).get('INBOX')!;
    assert.equal(inbox2.messages.length, 1);
    assert.deepEqual([...inbox2.messages[0]!.flags].sort(), ['\\Flagged', '\\Seen']);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare SqliteMailbox.open still works against a catalog database (compat surface)', () => {
  const db = new DatabaseSync(':memory:');
  SqliteCatalog.open(db);
  const direct = SqliteMailbox.open(db, 1);
  assert.equal(direct.append(Buffer.from('x')), 1, 'id-1 open addresses INBOX');
});
