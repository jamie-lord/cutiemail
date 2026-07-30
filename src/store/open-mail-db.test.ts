/**
 * openMailDb is the single open path, so its durability settings and its schema-version gate
 * bind every database the daemon touches. These pin the two invariants a reader/operator relies
 * on: the WAL + synchronous=FULL fsync posture that makes the `250`/`OK` acknowledgement a
 * durability promise (ADR 0028), and the refusal to open a database written by a newer binary
 * (which would otherwise write rows that binary misreads).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb, SCHEMA_VERSION, sqliteVersionAtLeast, MIN_SQLITE_VERSION } from './open-mail-db.ts';

test('openMailDb pins WAL + synchronous=FULL on a file-backed database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmaildb-'));
  try {
    const db = openMailDb(join(dir, 'x.db'));
    const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    // PRAGMA synchronous returns the numeric level: 1 is NORMAL, 2 is FULL, 3 is EXTRA.
    const sync = Number((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous);
    assert.equal(journal.toLowerCase(), 'wal', 'WAL is active on a file db');
    // FULL (2), not NORMAL (1): a COMMIT fsyncs the WAL, so a message answered `250` survives power
    // loss, not just a clean restart. Weakening this to NORMAL reopens the silent-loss window ADR
    // 0028 closes — the mutation that must fail this test.
    assert.equal(sync, 2, 'synchronous is FULL (2), so an acknowledged write is durable, not NORMAL (1)');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqliteVersionAtLeast orders dotted numeric versions, both directions, around the floor', () => {
  // At/above the floor.
  assert.equal(sqliteVersionAtLeast('3.51.3', '3.51.3'), true, 'exact equal is at-least');
  assert.equal(sqliteVersionAtLeast('3.51.4', '3.51.3'), true, 'higher patch');
  assert.equal(sqliteVersionAtLeast('3.52.0', '3.51.3'), true, 'higher minor');
  assert.equal(sqliteVersionAtLeast('4.0.0', '3.51.3'), true, 'higher major');
  assert.equal(sqliteVersionAtLeast('3.51', '3.51.0'), true, 'missing component reads as 0');
  // Below the floor — the versions that must trigger doctor's warning.
  assert.equal(sqliteVersionAtLeast('3.51.2', '3.51.3'), false, 'lower patch');
  assert.equal(sqliteVersionAtLeast('3.50.4', '3.51.3'), false, 'the version Node 22.x bundled when this landed');
  assert.equal(sqliteVersionAtLeast('3.9.10', '3.51.3'), false, 'numeric, not lexical: 9 < 51');
  // The floor is a well-formed dotted version (guards against a typo like "3.51" or "v3.51.3").
  assert.match(MIN_SQLITE_VERSION, /^\d+\.\d+\.\d+$/, 'the floor constant is a clean X.Y.Z');
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
