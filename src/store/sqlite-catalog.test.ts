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

test('bare SqliteMailbox.open still works against a catalog database (compat surface)', () => {
  const db = new DatabaseSync(':memory:');
  SqliteCatalog.open(db);
  const direct = SqliteMailbox.open(db, 1);
  assert.equal(direct.append(Buffer.from('x')), 1, 'id-1 open addresses INBOX');
});
