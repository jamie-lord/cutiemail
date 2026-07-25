/**
 * The boot-time permission heal must cover DORMANT accounts too.
 *
 * `openMailDb` chmods a mail database to 0600 when it opens it, and `db-permissions.test.ts`
 * covers that path. But the store manager is lazy: a disabled account, or simply one nobody has
 * connected to since the daemon started, is never opened — so a database left world-readable by
 * an older build (before the 0600 hardening) would keep its permissions indefinitely, holding
 * every message that account ever received.
 *
 * `startServer` therefore walks the registry at boot and heals every registered path. That loop
 * was defended by no test at all: deleting it broke nothing, which in this repo is one refactor
 * away from being lost silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const mode = (p: string): number => statSync(p).mode & 0o777;

test('boot heals 0600 on a registered account whose mail database is never opened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-dormant-'));
  const controlPath = join(dir, 'control.db');
  const dormantPath = join(dir, 'mail-dormant.db');

  // A registry holding an account whose database exists on disk, world-readable, exactly as an
  // upgrade from a pre-hardening build would leave it. The account is DISABLED, so nothing in
  // the daemon will open it: only the boot sweep can fix its permissions.
  {
    const db = new DatabaseSync(controlPath);
    const registry = AccountRegistry.open(db);
    registry.upsert('dormant', 'pw', dormantPath, { enabled: false });
    registry.upsert('active', 'pw', join(dir, 'mail-active.db'));
    db.close();
  }
  writeFileSync(dormantPath, '');
  chmodSync(dormantPath, 0o644);
  assert.equal(mode(dormantPath), 0o644, 'precondition: the dormant database is world-readable');

  const cfg: MailServerConfig = {
    dbPath: controlPath,
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [],
    tls: { key: TEST_KEY, cert: TEST_CERT },
  };
  const server = await startServer(cfg);
  try {
    assert.equal(mode(dormantPath), 0o600, 'the dormant account\'s database is healed at boot');
  } finally {
    await server.close();
  }
});
