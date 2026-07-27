/**
 * Mail-database file permissions. A mail DB holds SCRAM credential material and raw
 * message bytes, so it must be owner-only (0600) — never group/world readable. A
 * DISABLED account's mail-<user>.db can linger at 0644: openMailDb heals
 * perms only when a handle is opened, and the lazy store manager never opens a dormant
 * account's DB, so the on-open heal never fired for it. The daemon now enforces 0600 on
 * every REGISTERED account's DB at boot (main.ts), which these tests pin down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMailDb, secureMailDbFile } from './open-mail-db.ts';
import { AccountRegistry } from './account-registry.ts';

const mode = (p: string): number => statSync(p).mode & 0o777;

test('secureMailDbFile tightens a world-readable file to owner-and-group, never world', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maildbperm-'));
  try {
    const f = join(dir, 'mail-charlie.db');
    writeFileSync(f, 'x');
    chmodSync(f, 0o644);
    assert.equal(mode(f), 0o644, 'precondition: file starts world-readable');
    secureMailDbFile(f);
    assert.equal(mode(f), 0o660, 'file is now owner-and-group');
    assert.equal(mode(f) & 0o007, 0, 'and world has been stripped, which is what a 0644 file was leaking');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secureMailDbFile is a no-op (no throw) for :memory: and a missing path', () => {
  assert.doesNotThrow(() => secureMailDbFile(':memory:'));
  assert.doesNotThrow(() => secureMailDbFile(join(tmpdir(), 'does-not-exist-zzz.db')));
});

test('openMailDb heals a pre-existing 0644 database on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maildbperm-'));
  try {
    const f = join(dir, 'mail.db');
    writeFileSync(f, '');
    chmodSync(f, 0o644);
    const db = openMailDb(f);
    db.close();
    assert.equal(mode(f), 0o660);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the boot heal fixes a DISABLED (dormant) account whose DB the daemon never opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maildbperm-'));
  try {
    const controlPath = join(dir, 'control.db');
    const controlDb = openMailDb(controlPath);
    const registry = AccountRegistry.open(controlDb);
    // A disabled account with an existing, world-readable mail DB — the dormant case.
    const charlie = join(dir, 'mail-charlie.db');
    writeFileSync(charlie, '');
    chmodSync(charlie, 0o644);
    registry.upsert('charlie', 'pw', charlie, { enabled: false, iterations: 1 });
    assert.equal(mode(charlie), 0o644, 'precondition: dormant DB is world-readable');

    // The exact boot-time heal main.ts performs over every registered account.
    for (const acct of registry.list()) secureMailDbFile(acct.mailDbPath);

    assert.equal(mode(charlie), 0o660, 'the disabled account DB was healed at boot');
    assert.equal(mode(charlie) & 0o007, 0, 'world gets nothing from a disabled account either');
    controlDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a WAL database is three files, and all three are secured', () => {
  // The hole that made every earlier permission fix look correct and fail anyway: `secureMailDbFile`
  // fixed the main file while the -wal and -shm sidecars were recreated owner-only at the next
  // checkpoint. SQLite opens all three, so the sidecars decide who can actually open the database —
  // and a reader admitted by the main file was refused by them, reporting "unable to open database
  // file" against a database whose own mode looked right.
  const dir = mkdtempSync(join(tmpdir(), 'wal-perms-'));
  try {
    const db = join(dir, 'x.db');
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(db + suffix, '', { mode: 0o600 });
    secureMailDbFile(db);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(mode(db + suffix), 0o660, `${suffix || 'the main file'} is owner-and-group`);
      assert.equal(mode(db + suffix) & 0o007, 0, `${suffix || 'the main file'} gives world nothing`);
    }
    // A database with no sidecars yet must not throw: they appear only once WAL mode is engaged.
    const fresh = join(dir, 'fresh.db');
    writeFileSync(fresh, '', { mode: 0o600 });
    assert.doesNotThrow(() => secureMailDbFile(fresh));
    assert.equal(mode(fresh), 0o660);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
