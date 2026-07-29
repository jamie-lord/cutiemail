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

test('verifyPassword: right password passes, wrong password and unknown login fail', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'correct horse', 'mail-alice.db');
  assert.equal(reg.verifyPassword('alice', 'correct horse'), true);
  assert.equal(reg.verifyPassword('alice', 'wrong'), false, 'wrong password rejected');
  assert.equal(reg.verifyPassword('bob', 'correct horse'), false, 'unknown login rejected');
});

test('a disabled account fails auth even with the right password, until re-enabled', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'pw', 'mail-alice.db', { enabled: false });
  assert.equal(reg.verifyPassword('alice', 'pw'), false, 'disabled → no auth');
  assert.equal(reg.lookup('alice')?.enabled, false);
  reg.setEnabled('alice', true);
  assert.equal(reg.verifyPassword('alice', 'pw'), true, 're-enabled → auth');
});

test('a login is case-insensitive identity across every login-keyed operation', async () => {
  // Routing (resolveLocalPart) and creation (nameTaken) have always compared lower(login), and
  // mail-<login>.db collides case-insensitively on a case-insensitive filesystem — so a login IS
  // case-insensitive identity. Any statement that disagreed fragmented the account across
  // spellings: mail to ALICE@ routed to alice while AUTH as ALICE failed, and `disable ALICE`
  // matched no row at all.
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'correct horse', 'mail-alice.db');

  for (const spelling of ['alice', 'Alice', 'ALICE', 'aLiCe']) {
    assert.equal(reg.verifyPassword(spelling, 'correct horse'), true, `auth as ${spelling}`);
    assert.equal(reg.lookup(spelling)?.login, 'alice', `${spelling} resolves to the stored spelling`);
    assert.equal(reg.resolveLocalPart(spelling), 'alice', `${spelling} routes`);
  }

  // Negative controls: case-insensitivity must not weaken the credential or the enabled gate.
  assert.equal(reg.verifyPassword('ALICE', 'wrong'), false, 'wrong password still rejected');
  assert.equal(reg.verifyPassword('nobody', 'correct horse'), false, 'unknown login still rejected');

  reg.setEnabled('ALICE', false);
  assert.equal(reg.lookup('alice')?.enabled, false, 'disable reaches the row whatever case is typed');
  assert.equal(reg.verifyPassword('alice', 'correct horse'), false, 'disabled → no auth');
  reg.setEnabled('alice', true);

  // Aliases and app passwords key on the login too, so they must canonicalise on write.
  const secret = reg.addAppPassword('ALICE', 'phone', 1);
  assert.equal(reg.verifyPassword('alice', secret), true, 'app password added as ALICE authenticates alice');
  assert.deepEqual(
    reg.listAppPasswords('alice').map((r) => r.name),
    ['phone'],
    'and is listed under the canonical login',
  );
  assert.equal(reg.appPasswordNameTaken('Alice', 'phone'), true, 'name collision is seen whatever case');
  assert.equal(reg.removeAppPassword('aLiCe', 'phone'), true, 'and it is revocable whatever case');

  reg.addAlias('Sales', 'ALICE');
  assert.deepEqual(reg.aliasesFor('alice'), ['sales'], 'alias owned by ALICE is listed for alice');
  assert.equal(reg.resolveLocalPart('SALES'), 'alice', 'and still routes');
});

test('a password rotation typed in the wrong case replaces the credential, never forks the account', async () => {
  // INSERT OR REPLACE keys on the case-SENSITIVE primary key, so an upsert that wrote the raw
  // spelling added a SECOND row for the same identity: `set-password ALICE` reported success while
  // auth kept reading the original row — a rotation that silently left the old password working.
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'old password', 'mail-alice.db');
  reg.upsert('ALICE', 'new password', 'mail-alice.db');

  assert.deepEqual(
    reg.list().map((a) => a.login),
    ['alice'],
    'still exactly one account, under its stored spelling',
  );
  assert.equal(reg.verifyPassword('alice', 'new password'), true, 'the rotation took effect');
  assert.equal(reg.verifyPassword('alice', 'old password'), false, 'the old credential no longer authenticates');
});

test('the registry refuses to open a database whose logins differ only in case', async () => {
  // Defence in depth for the above: the database itself enforces case-insensitive identity, so a
  // future write path that forgets to canonicalise fails loudly instead of forking an account.
  const db = new DatabaseSync(':memory:');
  AccountRegistry.open(db);
  // Forge the state a pre-guard env seed could leave behind, bypassing the registry's own writers.
  db.exec("DROP INDEX accounts_login_nocase");
  const cols = "(login, salt, iterations, hash, stored_key, server_key, mail_db_path, enabled)";
  db.exec(`INSERT INTO accounts ${cols} VALUES ('Alice', x'00', 1, 'sha256', x'00', x'00', 'mail-Alice.db', 1)`);
  db.exec(`INSERT INTO accounts ${cols} VALUES ('alice', x'00', 1, 'sha256', x'00', x'00', 'mail-alice.db', 1)`);

  assert.throws(
    () => AccountRegistry.open(db),
    (e: Error) => /differ only in case/.test(e.message) && /Alice/.test(e.message),
    'the error names the colliding pair rather than surfacing a bare SQLite failure',
  );
});

test('lookup returns routing; unknown login is undefined', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'pw', '/var/lib/mail/mail-alice.db');
  assert.deepEqual(reg.lookup('alice'), { login: 'alice', mailDbPath: '/var/lib/mail/mail-alice.db', enabled: true });
  assert.equal(reg.lookup('nobody'), undefined);
});

test('list enumerates every account in insertion order', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'a', 'mail-alice.db');
  reg.upsert('bob', 'b', 'mail-bob.db');
  reg.upsert('carol', 'c', 'mail-carol.db');
  assert.deepEqual(
    reg.list().map((r) => r.login),
    ['alice', 'bob', 'carol'],
  );
});

test('credentials and routing survive a close/reopen of the same database file', async () => {
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

test('app passwords: each authenticates like the primary, is independently revocable (ADR 0017)', async () => {
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

test('app passwords: a disabled account fails auth on the app password too', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'primary-password', 'mail-alice.db');
  const secret = reg.addAppPassword('alice', 'phone', 1000);
  assert.equal(reg.verifyPassword('alice', secret), true);
  reg.setEnabled('alice', false);
  assert.equal(reg.verifyPassword('alice', secret), false, 'disabling the account disables its app passwords');
  reg.setEnabled('alice', true);
  assert.equal(reg.verifyPassword('alice', secret), true, 're-enabling restores them');
});

test('negative control: an app password secret is never written to the database', async () => {
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

test('negative control: the database never contains the plaintext password', async () => {
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

test('rotating a password does not move the postmaster mailbox to another account', () => {
  // `upsert` used INSERT OR REPLACE, and with a TEXT primary key SQLite deletes and reinserts —
  // giving the row a NEW rowid. `list()` orders by rowid and the postmaster fallback takes the
  // first enabled row, so `account set-password alice` silently handed postmaster@ — abuse
  // reports, DMARC aggregate reports, TLS-RPT, CA validation mail — and the right to SEND as
  // postmaster@ to whoever was created next. The trigger is the compromise-response action
  // itself: rotate a password after a breach and the mailbox moves.
  //
  // `setEnabled` was always a rowid-preserving UPDATE; this is that guard's missing twin.
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'password-one', ':memory:');
  reg.upsert('bob', 'password-two', ':memory:');
  assert.equal(reg.resolveLocalPart('postmaster'), 'alice', 'precondition: postmaster falls back to alice');

  reg.upsert('alice', 'password-three', ':memory:'); // a rotation, not a creation

  assert.equal(reg.resolveLocalPart('postmaster'), 'alice', 'postmaster did not move');
  assert.deepEqual(reg.list().map((a) => a.login), ['alice', 'bob'], 'creation order is preserved');
  assert.equal(reg.verifyPassword('alice', 'password-three'), true, 'the new password works');
  assert.equal(reg.verifyPassword('alice', 'password-one'), false, 'the old one does not');
});
