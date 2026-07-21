/**
 * Disabling the primary (MAIL_USER / accounts[0]) account must NOT brick the daemon
 * The startup "at least one account" check used to fix on
 * accounts[0], whose store resolves to undefined when disabled — so the whole server
 * (including every OTHER enabled account) failed to boot. It now scans for any enabled
 * account, and only a genuinely all-disabled registry is fatal (and then it fails closed
 * without leaking the bound listeners).
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

function configIn(dir: string): MailServerConfig {
  return {
    dbPath: join(dir, 'control.db'),
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [
      { user: 'alice', pass: 'alice-pass' }, // the PRIMARY (accounts[0])
      { user: 'bob', pass: 'bob-pass' },
    ],
    tls: { key: TEST_KEY, cert: TEST_CERT },
  };
}

test('disabling the primary account does not brick the daemon (a secondary keeps it up)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disable-primary-'));
  try {
    // Boot once to provision alice + bob.
    const s1 = await startServer(configIn(dir));
    await s1.close();

    // Disable the PRIMARY (alice) directly in the control DB, as the account CLI would.
    const db = openMailDb(join(dir, 'control.db'));
    AccountRegistry.open(db).setEnabled('alice', false);
    db.close();

    // Reboot: this used to throw ("a mail server needs at least one account") and take the
    // whole server — including the still-enabled bob — down. It must now boot cleanly.
    const s2 = await startServer(configIn(dir));
    assert.ok(s2.imap.port > 0, 'the daemon booted with the primary disabled');
    // bob (enabled) can still log in over IMAPS.
    assert.ok(s2.stores.get('bob') !== undefined, 'the enabled secondary account is served');
    assert.equal(s2.stores.get('alice'), undefined, 'the disabled primary is not served');
    await s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an all-disabled registry fails closed without leaking listeners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'all-disabled-'));
  try {
    const s1 = await startServer(configIn(dir));
    await s1.close();
    const db = openMailDb(join(dir, 'control.db'));
    const reg = AccountRegistry.open(db);
    reg.setEnabled('alice', false);
    reg.setEnabled('bob', false);
    db.close();

    // With every account disabled there is genuinely nothing to serve — it throws, but the
    // listeners it bound before the check must be torn down (no orphaned handles). If they
    // leaked, node's test runner would hang after the assertion on the open sockets.
    await assert.rejects(() => startServer(configIn(dir)), /at least one enabled account/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
