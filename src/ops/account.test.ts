/**
 * `account` (backlog B3) — provisioning without passwords in the environment.
 *
 * The security property under test, both directions:
 *   - the CLI-provisioned password authenticates (via the registry's real
 *     verifyPassword) and the plaintext NEVER lands in the database file
 *     (negative control: the raw bytes are scanned for it);
 *   - the ADR 0012 seeding rule: env accounts are CREATE-ONLY — an existing
 *     account's password is NOT overwritten at boot (negative control: the
 *     pre-upgrade upsert behaviour would make the old password fail).
 *
 * Prompts are injected (SecretReader), so add/set-password run non-interactively.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAccount, validLogin, type PasswordSource } from './account.ts';
import { seedAccounts } from '../main.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'account-test-'));
}
interface Cap {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out(l: string): void; err(l: string): void };
}
function capture(): Cap {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => void out.push(l), err: (l) => void err.push(l) } };
}
/** An interactive PasswordSource fed from a queue — each prompt consumes one entry. */
function secrets(...entries: string[]): PasswordSource {
  const q = [...entries];
  return { interactive: true, read: () => Promise.resolve(q.shift() ?? '') };
}

test('add provisions a working account and the password never touches the disk', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const cap = capture();
    const code = await runAccount(['add', 'alice', '--db', dbPath], cap.io, {}, secrets('s3cret-hunter2', 's3cret-hunter2'));
    assert.equal(code, 0);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('alice', 's3cret-hunter2'), true);
    assert.equal(registry.verifyPassword('alice', 'wrong'), false);
    assert.equal(registry.lookup('alice')!.mailDbPath, join(dir, 'mail-alice.db'));
    db.close();

    // NEGATIVE CONTROL: the plaintext must not appear anywhere in the file bytes
    // (only SCRAM StoredKey/ServerKey are stored). A regression to storing the
    // password would fail this scan.
    const raw = readFileSync(dbPath);
    assert.equal(raw.includes(Buffer.from('s3cret-hunter2')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new account uses a modern PBKDF2 iteration count and rejects a case-folding login (run-4)', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    assert.equal(await runAccount(['add', 'Bob', '--db', dbPath], capture().io, {}, secrets('pw-one', 'pw-one')), 0);

    // PBKDF2 iterations must be the modern default (>= 600k), not the RFC 7677 floor of 4096.
    const db = openMailDb(dbPath);
    const row = db.prepare('SELECT iterations FROM accounts WHERE login = ?').get('Bob') as { iterations: number };
    assert.ok(row.iterations >= 600_000, `iterations must be >= 600000, got ${row.iterations}`);
    db.close();

    // A login that case-folds to an existing one is refused — on a case-insensitive filesystem
    // "Bob" and "bob" would share one mail-<login>.db despite distinct credentials.
    const cap = capture();
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], cap.io, {}, secrets('pw-two', 'pw-two')), 1);
    assert.match(cap.err.join('\n'), /case-insensitive|collides/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mail database is created private (0600), never world/group readable (run-4)', () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'perms.db');
    openMailDb(dbPath).close();
    const mode = statSync(dbPath).mode & 0o777;
    assert.equal(mode, 0o600, `the DB (SCRAM material + raw mail) must be 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add refuses an existing login; mismatched or empty confirmation creates nothing', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('pw', 'pw')), 0);
    // Existing login → error, and the original password still verifies.
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('other', 'other')), 1);
    // Mismatched confirmation → nothing created.
    assert.equal(await runAccount(['add', 'carol', '--db', dbPath], capture().io, {}, secrets('one', 'two')), 1);
    // Empty password → nothing created.
    assert.equal(await runAccount(['add', 'dave', '--db', dbPath], capture().io, {}, secrets('', '')), 1);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('bob', 'pw'), true);
    assert.equal(registry.lookup('carol'), undefined);
    assert.equal(registry.lookup('dave'), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set-password rotates the credential and preserves routing + enabled state', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    await runAccount(['add', 'erin', '--db', dbPath], capture().io, {}, secrets('old-pw', 'old-pw'));
    assert.equal(await runAccount(['set-password', 'erin', '--db', dbPath], capture().io, {}, secrets('new-pw', 'new-pw')), 0);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('erin', 'new-pw'), true);
    assert.equal(registry.verifyPassword('erin', 'old-pw'), false); // the rotation took
    assert.equal(registry.lookup('erin')!.mailDbPath, join(dir, 'mail-erin.db'));
    db.close();

    // Unknown login is an error, not a silent create.
    assert.equal(await runAccount(['set-password', 'nobody', '--db', dbPath], capture().io, {}, secrets('x', 'x')), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disable refuses auth (reversibly) and never touches the mailbox database path', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    await runAccount(['add', 'frank', '--db', dbPath], capture().io, {}, secrets('pw', 'pw'));
    assert.equal(await runAccount(['disable', 'frank', '--db', dbPath], capture().io, {}), 0);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('frank', 'pw'), false); // disabled = no auth
    assert.equal(registry.lookup('frank')!.enabled, false);
    assert.equal(registry.lookup('frank')!.mailDbPath, join(dir, 'mail-frank.db')); // untouched
    db.close();

    assert.equal(await runAccount(['enable', 'frank', '--db', dbPath], capture().io, {}), 0);
    const db2 = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db2).verifyPassword('frank', 'pw'), true); // reversible
    db2.close();

    const cap = capture();
    assert.equal(await runAccount(['disable', 'ghost', '--db', dbPath], cap.io, {}), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list shows every account with its state', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    await runAccount(['add', 'alice', '--db', dbPath], capture().io, {}, secrets('a', 'a'));
    await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('b', 'b'));
    await runAccount(['disable', 'bob', '--db', dbPath], capture().io, {});
    const cap = capture();
    assert.equal(await runAccount(['list', '--db', dbPath], cap.io, {}), 0);
    const text = cap.out.join('\n');
    assert.match(text, /enabled\s+alice/);
    assert.match(text, /DISABLED\s+bob/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a piped (non-interactive) password is read exactly once — echo "pw" | account add works', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    // One entry only; a second read would get '' and wrongly report a mismatch —
    // this is the exact failure observed on the first live run.
    const piped: PasswordSource = { interactive: false, read: () => Promise.resolve('piped-pw') };
    assert.equal(await runAccount(['add', 'scripted', '--db', dbPath], capture().io, {}, piped), 0);
    const db = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db).verifyPassword('scripted', 'piped-pw'), true);
    db.close();
    // An empty piped password is still refused.
    const empty: PasswordSource = { interactive: false, read: () => Promise.resolve('') };
    assert.equal(await runAccount(['add', 'nopw', '--db', dbPath], capture().io, {}, empty), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logins that would be unsafe as filenames or ambiguous in addresses are refused', async () => {
  for (const bad of ['', '../etc', 'a/b', 'a:b', 'a,b', 'a@b', '.hidden', 'x'.repeat(65)]) {
    assert.equal(validLogin(bad), false, `should refuse: ${JSON.stringify(bad)}`);
    const cap = capture();
    assert.equal(await runAccount(['add', bad, '--db', ':memory:'], cap.io, {}, secrets('p', 'p')), 2, `exit 2 for ${JSON.stringify(bad)}`);
  }
  for (const good of ['alice', 'a', 'jamie.lord', 'test-2', 'A_b']) {
    assert.equal(validLogin(good), true, `should accept: ${good}`);
  }
});

test('ADR 0012 seeding: env accounts are create-only — an existing password is never overwritten at boot', () => {
  const dir = tmp();
  try {
    const db = openMailDb(join(dir, 'control.db'));
    const registry = AccountRegistry.open(db);
    const logs: string[] = [];

    // First boot: the account doesn't exist — env seeds it.
    seedAccounts(registry, [{ user: 'demo', pass: 'boot-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.equal(registry.verifyPassword('demo', 'boot-pw'), true);

    // Operator rotates the password out-of-band (what `account set-password` does).
    registry.upsert('demo', 'rotated-pw', ':memory:');

    // Next boot still carries the STALE env password. The pre-ADR behaviour
    // (unconditional upsert) would silently revert the rotation — the negative
    // control is that the rotated password must still be the one that works.
    seedAccounts(registry, [{ user: 'demo', pass: 'boot-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.equal(registry.verifyPassword('demo', 'rotated-pw'), true);
    assert.equal(registry.verifyPassword('demo', 'boot-pw'), false);
    // And the operator is told, not left guessing why the env password fails.
    assert.equal(logs.filter((l) => l.includes('IGNORED')).length, 1);

    // Same-password reboot is silent (no false alarm every boot).
    seedAccounts(registry, [{ user: 'demo', pass: 'rotated-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.equal(logs.filter((l) => l.includes('IGNORED')).length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
