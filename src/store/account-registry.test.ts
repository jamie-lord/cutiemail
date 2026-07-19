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

test('app passwords: each authenticates like the primary, is independently revocable (ADR 0017)', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'primary-password', 'mail-alice.db');
  const phone = reg.addAppPassword('alice', 'phone', 1000);
  const laptop = reg.addAppPassword('alice', 'laptop', 2000);
  assert.notEqual(phone, laptop, 'each app password is a distinct generated secret');

  // Every credential authenticates as the same account.
  assert.equal(reg.verifyPassword('alice', 'primary-password'), true, 'the primary still works');
  assert.equal(reg.verifyPassword('alice', phone), true, 'the phone app password authenticates');
  assert.equal(reg.verifyPassword('alice', laptop), true, 'the laptop app password authenticates');
  // A wrong secret and another account are still refused.
  assert.equal(reg.verifyPassword('alice', 'not-a-real-secret'), false);
  assert.equal(reg.verifyPassword('bob', phone), false, 'the app password is scoped to its owner');

  // Revoke ONE: it stops working; the others (and the primary) are untouched.
  assert.equal(reg.removeAppPassword('alice', 'phone'), true);
  assert.equal(reg.verifyPassword('alice', phone), false, 'the revoked app password no longer authenticates');
  assert.equal(reg.verifyPassword('alice', laptop), true, 'a sibling app password still works');
  assert.equal(reg.verifyPassword('alice', 'primary-password'), true, 'the primary is unaffected');

  // list shows names + created, never the secret; revoking a missing one is false.
  assert.deepEqual(reg.listAppPasswords('alice'), [{ name: 'laptop', created: 2000 }]);
  assert.equal(reg.removeAppPassword('alice', 'phone'), false, 'already revoked');
  assert.equal(reg.appPasswordNameTaken('alice', 'laptop'), true);
  assert.equal(reg.appPasswordNameTaken('alice', 'phone'), false);
});

test('app passwords: a disabled account fails auth on the app password too', () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'primary-password', 'mail-alice.db');
  const secret = reg.addAppPassword('alice', 'phone', 1000);
  assert.equal(reg.verifyPassword('alice', secret), true);
  reg.setEnabled('alice', false);
  assert.equal(reg.verifyPassword('alice', secret), false, 'disabling the account disables its app passwords');
  reg.setEnabled('alice', true);
  assert.equal(reg.verifyPassword('alice', secret), true, 're-enabling restores them');
});

test('negative control: an app password secret is never written to the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acctreg-'));
  const path = join(dir, 'control.db');
  try {
    const db = new DatabaseSync(path);
    const reg = AccountRegistry.open(db);
    reg.upsert('alice', 'primary-password', 'mail-alice.db');
    const secret = reg.addAppPassword('alice', 'phone', 1000);
    db.close();
    const bytes = readFileSync(path);
    assert.ok(!bytes.includes(Buffer.from(secret, 'latin1')), 'the app password secret must never reach disk — only SCRAM material');
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
