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

test('secureMailDbFile tightens a world-readable file to 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maildbperm-'));
  try {
    const f = join(dir, 'mail-charlie.db');
    writeFileSync(f, 'x');
    chmodSync(f, 0o644);
    assert.equal(mode(f), 0o644, 'precondition: file starts world-readable');
    secureMailDbFile(f);
    assert.equal(mode(f), 0o600, 'file is now owner-only');
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
    assert.equal(mode(f), 0o600);
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

    assert.equal(mode(charlie), 0o600, 'the disabled account DB was healed at boot');
    controlDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
