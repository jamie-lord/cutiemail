/**
 * `init` — the passwordless first-run. It must create the primary account by writing
 * SCRAM to the registry (never a plaintext password to disk or env), refuse to run once
 * any account exists (so it can't clobber a live deployment), and print how to run with
 * no password in the environment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from './init.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import type { PasswordSource } from './account.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'init-test-'));
function capture(): { out: string[]; err: string[]; io: { out(l: string): void; err(l: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => void out.push(l), err: (l) => void err.push(l) } };
}
const secrets = (...entries: string[]): PasswordSource => {
  const q = [...entries];
  return { interactive: true, read: () => Promise.resolve(q.shift() ?? '') };
};

test('init creates the first account; the password authenticates and never touches disk', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const cap = capture();
    const code = await runInit(['admin'], cap.io, { MAIL_CONTROL_DB: dbPath, MAIL_DOMAIN: 'mail.example.test' }, secrets('s3cret-pw', 's3cret-pw'));
    assert.equal(code, 0);

    // The credential works via the real registry, and the plaintext is nowhere on disk.
    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.verifyPassword('admin', 's3cret-pw'), true);
    assert.equal(registry.verifyPassword('admin', 'wrong'), false);
    const row = registry.lookup('admin');
    assert.equal(row?.mailDbPath, join(dir, 'mail-admin.db'));
    db.close();
    assert.ok(!readFileSync(dbPath).includes(Buffer.from('s3cret-pw')), 'plaintext password must not be in the control DB');

    // The guidance is passwordless and echoes the configured domain.
    const printed = cap.out.join('\n');
    assert.match(printed, /No MAIL_USER \/ MAIL_PASS \/ MAIL_ACCOUNTS/);
    assert.match(printed, /MAIL_DOMAIN=mail\.example\.test/);
    assert.doesNotMatch(printed, /s3cret-pw/, 'the password is never echoed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init refuses once any account exists — points at account add', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    // First init succeeds.
    assert.equal(await runInit(['admin'], capture().io, { MAIL_CONTROL_DB: dbPath }, secrets('admin-pw1', 'admin-pw1')), 0);
    // Second init refuses without touching the existing account.
    const cap = capture();
    const code = await runInit(['other'], cap.io, { MAIL_CONTROL_DB: dbPath }, secrets('pw2', 'pw2'));
    assert.equal(code, 1);
    assert.match(cap.err.join('\n'), /already initialised/);

    const db = openMailDb(dbPath);
    const registry = AccountRegistry.open(db);
    assert.equal(registry.lookup('other'), undefined, 'the refused account was not created');
    assert.equal(registry.verifyPassword('admin', 'admin-pw1'), true, 'the existing account is untouched');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init rejects an invalid login (usage error) and an empty/mismatched password', async () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    assert.equal(await runInit(['bad/login'], capture().io, { MAIL_CONTROL_DB: dbPath }, secrets('pw', 'pw')), 2);
    assert.equal(await runInit([], capture().io, { MAIL_CONTROL_DB: dbPath }, secrets('pw', 'pw')), 2);
    assert.equal(await runInit(['admin'], capture().io, { MAIL_CONTROL_DB: dbPath }, secrets('', '')), 1);
    assert.equal(await runInit(['admin'], capture().io, { MAIL_CONTROL_DB: dbPath }, secrets('a', 'b')), 1);
    // A too-short password (below the policy floor) is refused, nothing created.
    const cap = capture();
    assert.equal(await runInit(['admin'], cap.io, { MAIL_CONTROL_DB: dbPath }, secrets('short', 'short')), 1);
    assert.match(cap.err.join('\n'), /too short/i);
    // None of those created anything.
    const db = openMailDb(dbPath);
    assert.equal(AccountRegistry.open(db).list().length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
