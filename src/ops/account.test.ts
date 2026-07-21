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
import { runAccount, validLogin, passwordPolicyError, MIN_PASSWORD_LENGTH, type PasswordSource } from './account.ts';
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

test('a new account uses a modern PBKDF2 iteration count and rejects a case-folding login', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    assert.equal(await runAccount(['add', 'Bob', '--db', dbPath], capture().io, {}, secrets('bob-pw-one', 'bob-pw-one')), 0);

    // PBKDF2 iterations must be the modern default (>= 600k), not the RFC 7677 floor of 4096.
    const db = openMailDb(dbPath);
    const row = db.prepare('SELECT iterations FROM accounts WHERE login = ?').get('Bob') as { iterations: number };
    assert.ok(row.iterations >= 600_000, `iterations must be >= 600000, got ${row.iterations}`);
    db.close();

    // A login that case-folds to an existing one is refused — on a case-insensitive filesystem
    // "Bob" and "bob" would share one mail-<login>.db despite distinct credentials.
    const cap = capture();
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], cap.io, {}, secrets('bob-pw-two', 'bob-pw-two')), 1);
    assert.match(cap.err.join('\n'), /case-insensitive|collides/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mail database is created private (0600), never world/group readable', () => {
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

test('password policy: passwordPolicyError rejects below the floor, accepts at/above it', () => {
  assert.ok(passwordPolicyError('short') !== null, 'a short password is rejected');
  assert.ok(passwordPolicyError('x'.repeat(MIN_PASSWORD_LENGTH - 1)) !== null, 'one below the floor is rejected');
  assert.equal(passwordPolicyError('x'.repeat(MIN_PASSWORD_LENGTH)), null, 'exactly the floor is accepted');
  assert.equal(passwordPolicyError('a-perfectly-fine-password'), null, 'a normal password is accepted');
});

test('add / set-password / policy: a too-short password is refused and nothing is created or changed', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    // add: below the floor → refused, account not created.
    const cap = capture();
    assert.equal(await runAccount(['add', 'tiny', '--db', dbPath], cap.io, {}, secrets('short', 'short')), 1);
    assert.match(cap.err.join('\n'), /too short/i);
    const db = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db).lookup('tiny'), undefined, 'nothing was created');
    db.close();
    // set-password: create with a good password, then a too-short rotation is refused and the
    // original still verifies (negative control — the weak password did not take).
    assert.equal(await runAccount(['add', 'ok', '--db', dbPath], capture().io, {}, secrets('good-enough-pw', 'good-enough-pw')), 0);
    const cap2 = capture();
    assert.equal(await runAccount(['set-password', 'ok', '--db', dbPath], cap2.io, {}, secrets('weak', 'weak')), 1);
    assert.match(cap2.err.join('\n'), /too short/i);
    const db2 = openMailDb(dbPath);
    const reg = AccountRegistry.open(db2);
    assert.equal(reg.verifyPassword('ok', 'good-enough-pw'), true, 'the original password is unchanged');
    assert.equal(reg.verifyPassword('ok', 'weak'), false, 'the too-short password did not take');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add refuses an existing login; mismatched or empty confirmation creates nothing', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('bob-secret', 'bob-secret')), 0);
    // Existing login → error, and the original password still verifies.
    assert.equal(await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('other', 'other')), 1);
    // Mismatched confirmation → nothing created.
    assert.equal(await runAccount(['add', 'carol', '--db', dbPath], capture().io, {}, secrets('one', 'two')), 1);
    // Empty password → nothing created.
    assert.equal(await runAccount(['add', 'dave', '--db', dbPath], capture().io, {}, secrets('', '')), 1);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('bob', 'bob-secret'), true);
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
    await runAccount(['add', 'erin', '--db', dbPath], capture().io, {}, secrets('erin-old-pw', 'erin-old-pw'));
    assert.equal(await runAccount(['set-password', 'erin', '--db', dbPath], capture().io, {}, secrets('erin-new-pw', 'erin-new-pw')), 0);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('erin', 'erin-new-pw'), true);
    assert.equal(registry.verifyPassword('erin', 'erin-old-pw'), false); // the rotation took
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
    await runAccount(['add', 'frank', '--db', dbPath], capture().io, {}, secrets('bob-secret', 'bob-secret'));
    assert.equal(await runAccount(['disable', 'frank', '--db', dbPath], capture().io, {}), 0);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('frank', 'bob-secret'), false); // disabled = no auth
    assert.equal(registry.lookup('frank')!.enabled, false);
    assert.equal(registry.lookup('frank')!.mailDbPath, join(dir, 'mail-frank.db')); // untouched
    db.close();

    assert.equal(await runAccount(['enable', 'frank', '--db', dbPath], capture().io, {}), 0);
    const db2 = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db2).verifyPassword('frank', 'bob-secret'), true); // reversible
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
    await runAccount(['add', 'alice', '--db', dbPath], capture().io, {}, secrets('alice-secret', 'alice-secret'));
    await runAccount(['add', 'bob', '--db', dbPath], capture().io, {}, secrets('bob-secret-2', 'bob-secret-2'));
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
    // One entry only; a second read would get '' and wrongly report a mismatch.
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

    // Same-password reboot is silent about IGNORED (no false alarm every boot).
    seedAccounts(registry, [{ user: 'demo', pass: 'rotated-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.equal(logs.filter((l) => l.includes('IGNORED')).length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedAccounts advises removing redundant plaintext seeds once the account exists', async () => {
  const dir = tmp();
  try {
    const db = openMailDb(join(dir, 'control.db'));
    const registry = AccountRegistry.open(db);
    const logs: string[] = [];
    // First boot (genuine bootstrap): the account is created — no "redundant" advisory.
    seedAccounts(registry, [{ user: 'demo', pass: 'boot-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.equal(logs.filter((l) => l.includes('redundant')).length, 0, 'first boot bootstraps — not redundant');
    // Every subsequent boot: the seed is now redundant → one advisory to remove it.
    seedAccounts(registry, [{ user: 'demo', pass: 'boot-pw', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    const advisories = logs.filter((l) => l.includes('redundant plaintext'));
    assert.equal(advisories.length, 1, 'one advisory on a redundant reboot');
    assert.match(advisories[0]!, /MAIL_PASS\/MAIL_ACCOUNTS/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedAccounts warns (but does not fail) when a newly-seeded password is below the policy floor', () => {
  const dir = tmp();
  try {
    const db = openMailDb(join(dir, 'control.db'));
    const registry = AccountRegistry.open(db);
    const logs: string[] = [];
    // A weak env seed is ADVISORY only — the account is still created (a boot must not fail on it),
    // but the operator is told to strengthen it. This is the softer counterpart of the hard reject
    // the interactive `account add` / `init` paths apply.
    seedAccounts(registry, [{ user: 'weak', pass: 'short', mailDbPath: ':memory:' }], (l) => void logs.push(l));
    assert.ok(registry.lookup('weak') !== undefined, 'the account is still created (no hard boot failure)');
    assert.equal(logs.filter((l) => /under \d+ characters/.test(l)).length, 1, 'one weak-password advisory');
    // A strong seed draws no such warning.
    const logs2: string[] = [];
    seedAccounts(registry, [{ user: 'strong', pass: 'a-strong-enough-pw', mailDbPath: ':memory:' }], (l) => void logs2.push(l));
    assert.equal(logs2.filter((l) => /under \d+ characters/.test(l)).length, 0, 'a strong seed is not warned about');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alias: add routes an address to an account, list shows it, remove clears it', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const env = { MAIL_CONTROL_DB: dbPath };
    // Create the owning account.
    assert.equal(await runAccount(['add', 'jamie'], capture().io, env, secrets('bob-secret', 'bob-secret')), 0);
    // Add two aliases.
    assert.equal(await runAccount(['alias', 'add', 'jamie', 'sales'], capture().io, env), 0);
    assert.equal(await runAccount(['alias', 'add', 'jamie', 'Support'], capture().io, env), 0); // normalises to lower

    // They resolve in the registry (what inbound routing uses).
    const db = openMailDb(dbPath);
    const reg = AccountRegistry.open(db);
    assert.equal(reg.resolveLocalPart('sales'), 'jamie');
    assert.equal(reg.resolveLocalPart('support'), 'jamie');
    assert.equal(reg.resolveLocalPart('jamie+tag'), 'jamie');
    db.close();

    // account list shows aliases inline.
    const listCap = capture();
    await runAccount(['list'], listCap.io, env);
    assert.match(listCap.out.join('\n'), /jamie.*aliases: sales, support/);

    // Remove one.
    assert.equal(await runAccount(['alias', 'remove', 'SALES'], capture().io, env), 0);
    const db2 = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db2).resolveLocalPart('sales'), undefined);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alias: rejects a missing account, collisions with a login/alias, and bad local-parts', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const env = { MAIL_CONTROL_DB: dbPath };
    await runAccount(['add', 'jamie'], capture().io, env, secrets('bob-secret', 'bob-secret'));
    await runAccount(['add', 'bob'], capture().io, env, secrets('bob-secret', 'bob-secret'));
    await runAccount(['alias', 'add', 'jamie', 'sales'], capture().io, env);

    // Owning account must exist.
    assert.equal(await runAccount(['alias', 'add', 'ghost', 'x'], capture().io, env), 1);
    // An alias cannot shadow a login...
    assert.equal(await runAccount(['alias', 'add', 'jamie', 'bob'], capture().io, env), 1);
    // ...nor an existing alias.
    assert.equal(await runAccount(['alias', 'add', 'bob', 'sales'], capture().io, env), 1);
    // Bad local-parts: a full address, and the reserved '+'.
    assert.equal(await runAccount(['alias', 'add', 'jamie', 'sales@example.com'], capture().io, env), 2);
    assert.equal(await runAccount(['alias', 'add', 'jamie', 'a+b'], capture().io, env), 2);
    // Usage errors.
    assert.equal(await runAccount(['alias', 'add', 'jamie'], capture().io, env), 2);
    assert.equal(await runAccount(['alias', 'frobnicate'], capture().io, env), 2);

    // And the reverse direction: a new login cannot collide with an existing alias.
    const addCap = capture();
    assert.equal(await runAccount(['add', 'sales'], addCap.io, env, secrets('bob-secret', 'bob-secret')), 1);
    assert.match(addCap.err.join('\n'), /already an alias/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-password: add prints a working secret ONCE, list shows it, remove revokes it', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const env = { MAIL_CONTROL_DB: dbPath };
    await runAccount(['add', 'jamie'], capture().io, env, secrets('primary-password', 'primary-password'));

    // add: prints the generated secret exactly once.
    const addCap = capture();
    assert.equal(await runAccount(['app-password', 'add', 'jamie', 'phone'], addCap.io, env), 0);
    // The secret is the indented line in the output; recover it to prove it authenticates.
    const secret = addCap.out.map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{20,}$/.test(l));
    assert.ok(secret !== undefined, 'a generated secret was printed');
    assert.match(addCap.out.join('\n'), /ONCE|once/, 'the operator is told it is shown once');

    // The secret authenticates as jamie via the real verify path; the primary still works too.
    const db = openMailDb(dbPath);
    const reg = AccountRegistry.open(db);
    assert.equal(reg.verifyPassword('jamie', secret!), true, 'the printed app password authenticates');
    assert.equal(reg.verifyPassword('jamie', 'primary-password'), true, 'the primary is unaffected');
    db.close();

    // list shows the name (never the secret); account list shows the count.
    const listCap = capture();
    await runAccount(['app-password', 'list', 'jamie'], listCap.io, env);
    assert.match(listCap.out.join('\n'), /phone/);
    assert.ok(!listCap.out.join('\n').includes(secret!), 'list never reveals the secret');
    const acctList = capture();
    await runAccount(['list'], acctList.io, env);
    assert.match(acctList.out.join('\n'), /app-passwords: 1/);

    // remove revokes it — it stops authenticating.
    assert.equal(await runAccount(['app-password', 'remove', 'jamie', 'phone'], capture().io, env), 0);
    const db2 = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db2).verifyPassword('jamie', secret!), false, 'the revoked secret no longer authenticates');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-password: rejects a missing account, a duplicate name, and bad usage', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const env = { MAIL_CONTROL_DB: dbPath };
    await runAccount(['add', 'jamie'], capture().io, env, secrets('primary-password', 'primary-password'));
    assert.equal(await runAccount(['app-password', 'add', 'jamie', 'phone'], capture().io, env), 0);

    assert.equal(await runAccount(['app-password', 'add', 'ghost', 'x'], capture().io, env), 1, 'no such account');
    const dupCap = capture();
    assert.equal(await runAccount(['app-password', 'add', 'jamie', 'phone'], dupCap.io, env), 1, 'duplicate name');
    assert.match(dupCap.err.join('\n'), /already has an app password/);
    assert.equal(await runAccount(['app-password', 'add', 'jamie', 'bad name'], capture().io, env), 2, 'invalid name');
    assert.equal(await runAccount(['app-password', 'add', 'jamie'], capture().io, env), 2, 'missing name');
    assert.equal(await runAccount(['app-password', 'remove', 'jamie', 'nope'], capture().io, env), 1, 'revoke a missing one');
    assert.equal(await runAccount(['app-password', 'list', 'ghost'], capture().io, env), 1, 'list for no account');
    assert.equal(await runAccount(['app-password', 'frobnicate'], capture().io, env), 2, 'unknown subcommand');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
