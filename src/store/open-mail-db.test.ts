/**
 * openMailDb is the single open path, so its durability settings and its schema-version gate
 * bind every database the daemon touches. These pin the two invariants a reader/operator relies
 * on: the WAL fsync posture the crash suite's recorded scope assumes, and the refusal to open a
 * database written by a newer binary (which would otherwise write rows that binary misreads).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb, SCHEMA_VERSION } from './open-mail-db.ts';

test('openMailDb pins WAL + synchronous=NORMAL on a file-backed database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmaildb-'));
  try {
    const db = openMailDb(join(dir, 'x.db'));
    const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    // PRAGMA synchronous returns the numeric level: 1 is NORMAL, 2 is FULL, 3 is EXTRA.
    const sync = Number((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous);
    assert.equal(journal.toLowerCase(), 'wal', 'WAL is active on a file db');
    assert.equal(sync, 1, 'synchronous is NORMAL (1), the recorded WAL pairing, not FULL (2)');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMailDb stamps a fresh database with the current schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmaildb-'));
  try {
    const db = openMailDb(join(dir, 'x.db'));
    const v = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    assert.equal(v, SCHEMA_VERSION, 'a new database is stamped with SCHEMA_VERSION');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMailDb upgrades an unstamped (pre-versioning) database in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmaildb-'));
  try {
    const path = join(dir, 'x.db');
    // Simulate a database created before versioning: user_version still 0.
    const seed = new DatabaseSync(path);
    seed.exec('PRAGMA user_version=0');
    seed.exec('CREATE TABLE t (x)');
    seed.close();
    const db = openMailDb(path);
    const v = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    assert.equal(v, SCHEMA_VERSION, 'an older database is stamped forward, not refused');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMailDb refuses a database written by a newer binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmaildb-'));
  try {
    const path = join(dir, 'x.db');
    const seed = new DatabaseSync(path);
    seed.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    seed.close();
    assert.throws(
      () => openMailDb(path),
      /written by a newer cutiemail/,
      'a strictly-newer on-disk schema version is fatal, not silently opened',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
