/**
 * The persistent account registry (ADR 0009): credentials + routing that survive a
 * restart, mirroring AccountStore's security property — the store holds SCRAM keys, not
 * the password. The negative controls prove the derivation actually gates auth (wrong
 * password fails, disabled fails) and that the password never reaches disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from './account-registry.ts';

test('verifyPassword: right password passes, wrong password and unknown login fail', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'correct horse', 'mail-alice.db');
  assert.equal(reg.verifyPassword('alice', 'correct horse'), true);
  assert.equal(reg.verifyPassword('alice', 'wrong'), false, 'wrong password rejected');
  assert.equal(reg.verifyPassword('bob', 'correct horse'), false, 'unknown login rejected');
});

test('a disabled account fails auth even with the right password, until re-enabled', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'pw', 'mail-alice.db', { enabled: false });
  assert.equal(reg.verifyPassword('alice', 'pw'), false, 'disabled → no auth');
  assert.equal(reg.lookup('alice')?.enabled, false);
  reg.setEnabled('alice', true);
  assert.equal(reg.verifyPassword('alice', 'pw'), true, 're-enabled → auth');
});

test('lookup returns routing; unknown login is undefined', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'pw', '/var/lib/mail/mail-alice.db');
  assert.deepEqual(reg.lookup('alice'), { login: 'alice', mailDbPath: '/var/lib/mail/mail-alice.db', enabled: true });
  assert.equal(reg.lookup('nobody'), undefined);
});

test('list enumerates every account in insertion order', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'a', 'mail-alice.db');
  reg.upsert('bob', 'b', 'mail-bob.db');
  reg.upsert('carol', 'c', 'mail-carol.db');
  assert.deepEqual(
    reg.list().map((r) => r.login),
    ['alice', 'bob', 'carol'],
  );
});

test('credentials and routing survive a close/reopen of the same database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acctreg-'));
  const path = join(dir, 'control.db');
  try {
    {
      const db = new DatabaseSync(path);
      const reg = AccountRegistry.open(db);
      reg.upsert('alice', 's3cret', 'mail-alice.db', { enabled: true });
      db.close();
    }
    // Reopen: a fresh process would see exactly this.
    const db2 = new DatabaseSync(path);
    const reg2 = AccountRegistry.open(db2);
    assert.equal(reg2.verifyPassword('alice', 's3cret'), true, 'password verifies after reopen');
    assert.equal(reg2.verifyPassword('alice', 'nope'), false);
    assert.equal(reg2.lookup('alice')?.mailDbPath, 'mail-alice.db', 'routing survives');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('negative control: the database never contains the plaintext password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acctreg-'));
  const path = join(dir, 'control.db');
  const password = 'UNIQUE-PLAINTEXT-marker-8842';
  try {
    const db = new DatabaseSync(path);
    const reg = AccountRegistry.open(db);
    reg.upsert('alice', password, 'mail-alice.db');
    db.close();
    const bytes = readFileSync(path);
    assert.ok(!bytes.includes(Buffer.from(password, 'latin1')), 'the password must never be written to disk');
    // And two different passwords must derive different stored keys (the derivation is real).
    const db2 = new DatabaseSync(':memory:');
    const r2 = AccountRegistry.open(db2);
    r2.upsert('a', 'password-one', 'x.db');
    r2.upsert('b', 'password-two', 'y.db');
    assert.equal(r2.verifyPassword('a', 'password-two'), false, "a's key does not match b's password");
    assert.equal(r2.verifyPassword('b', 'password-one'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
