/**
 * A build must refuse a database a NEWER build has migrated.
 *
 * Migrations here are forward-only and run on open, so an older binary meeting a newer database
 * does not fail — it runs statements against a shape that has moved, which is the worst kind of
 * failure. Self-update (ADR 0025) makes this reachable in practice: a rollback after a failed
 * cutover puts the previous version in front of a database the candidate already migrated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stampSchema, readSchemaVersion, CONTROL_SCHEMA, MAIL_SCHEMA } from './schema-version.ts';
import { AccountRegistry } from './account-registry.ts';
import { SqliteCatalog } from './sqlite-mailbox.ts';

test('opening stamps the current schema version on both database kinds', () => {
  const control = new DatabaseSync(':memory:');
  AccountRegistry.open(control);
  assert.equal(readSchemaVersion(control), CONTROL_SCHEMA.writes, 'control.db is stamped');

  const mail = new DatabaseSync(':memory:');
  SqliteCatalog.open(mail);
  assert.equal(readSchemaVersion(mail), MAIL_SCHEMA.writes, 'a mail database is stamped');
});

test('an unstamped database is adopted, not rejected', () => {
  // Every database written before the stamp existed is, by definition, at the shape the
  // unconditional migrations produce — so 0 means "old file", not "corrupt".
  const db = new DatabaseSync(':memory:');
  assert.equal(readSchemaVersion(db), 0);
  stampSchema(db, 'control', CONTROL_SCHEMA);
  assert.equal(readSchemaVersion(db), CONTROL_SCHEMA.writes);
});

test('a database from the FUTURE is refused, with a message naming the way out', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version = ${CONTROL_SCHEMA.writes + 5}`);
  assert.throws(
    () => stampSchema(db, 'control', CONTROL_SCHEMA),
    (e: Error) => /schema version \d+/.test(e.message) && /snapshot/.test(e.message),
    'refuses, and tells the operator to restore the snapshot or run the newer build',
  );
});

test('the real open paths refuse a future database too, not just the helper', () => {
  const control = new DatabaseSync(':memory:');
  AccountRegistry.open(control); // establishes the schema
  control.exec(`PRAGMA user_version = ${CONTROL_SCHEMA.writes + 1}`);
  assert.throws(() => AccountRegistry.open(control), /control database is at schema version/);

  const mail = new DatabaseSync(':memory:');
  SqliteCatalog.open(mail);
  mail.exec(`PRAGMA user_version = ${MAIL_SCHEMA.writes + 1}`);
  assert.throws(() => SqliteCatalog.open(mail), /mail database is at schema version/);
});

test('a database too old to migrate is refused rather than half-upgraded', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 1');
  assert.throws(
    () => stampSchema(db, 'control', { writes: 9, reads: 5 }),
    /no longer migrates/,
    'stepping through an intermediate version is better than an unknown migration path',
  );
});
