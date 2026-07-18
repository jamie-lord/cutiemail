/**
 * Passwordless boot (the `init` payoff): with NO env accounts (empty cfg.accounts — a unit
 * carrying no MAIL_USER/MAIL_PASS), the daemon must run entirely off the registry, which
 * `init`/`account` populate. It must NOT invent a demo/demo account when real ones exist,
 * and it must still expose an INBOX (derived from the registry, not the env seeds). As a
 * dev convenience, a genuinely empty registry with no config DOES get a demo/demo fallback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type MailServerConfig } from '../main.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

function passwordlessConfig(dir: string): MailServerConfig {
  return {
    dbPath: join(dir, 'control.db'),
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [], // a passwordless unit: no MAIL_USER/MAIL_PASS/MAIL_ACCOUNTS
    tls: { key: TEST_KEY, cert: TEST_CERT },
  };
}

test('boots off a pre-seeded registry with NO env accounts, and invents no demo account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passwordless-'));
  try {
    // Provision as `init`/`account` would: straight into the registry, no env.
    const setup = openMailDb(join(dir, 'control.db'));
    AccountRegistry.open(setup).upsert('zoe', 'zoe-pass', join(dir, 'mail-zoe.db'));
    setup.close();

    const s = await startServer(passwordlessConfig(dir));
    try {
      assert.ok(s.imap.port > 0, 'the daemon booted with no env accounts');
      assert.deepEqual([...s.logins], ['zoe'], 'serves the registry account and only that');
      assert.ok(s.stores.get('zoe') !== undefined, 'the registry account is served');
      assert.equal(s.stores.get('demo'), undefined, 'no demo/demo account was invented');
      // The registry was not polluted with a demo fallback either.
      const check = openMailDb(join(dir, 'control.db'));
      assert.equal(AccountRegistry.open(check).lookup('demo'), undefined);
      check.close();
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely empty registry with no config gets a demo/demo dev fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-fallback-'));
  try {
    const s = await startServer(passwordlessConfig(dir));
    try {
      assert.deepEqual([...s.logins], ['demo'], 'the dev fallback account is seeded and served');
      const check = openMailDb(join(dir, 'control.db'));
      assert.equal(AccountRegistry.open(check).verifyPassword('demo', 'demo'), true);
      check.close();
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
