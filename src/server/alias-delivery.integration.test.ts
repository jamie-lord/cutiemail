/**
 * Inbound delivery through aliases + subaddressing, end to end (ADR 0014). A message to an
 * alias or a `base+tag` subaddress must land in the OWNER's mailbox; an unknown address must
 * still be refused at RCPT (no catch-all, no backscatter — ADR 0009). This proves the wiring
 * from the RCPT chokepoint through to storage, not just the resolver in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mail.example.test';

async function sendTo(port: number, rcpt: string, subject: string): Promise<{ ok: boolean; failure: string | null }> {
  const data = Buffer.from(`Subject: ${subject}\r\n\r\nbody for ${rcpt}\r\n`, 'latin1');
  const r = await deliver(
    { host: '127.0.0.1', port, tls: 'none' },
    { from: 'someone@example.net', recipients: [rcpt], data, clientName: 'sender.example.net' },
  );
  return { ok: r.ok, failure: r.failure };
}

test('mail to an alias and to a subaddress lands in the owner mailbox; an unknown address is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alias-delivery-'));
  try {
    // Provision alice + an alias exactly as `account`/`init` would (registry is the truth).
    const dbPath = join(dir, 'control.db');
    const setup = openMailDb(dbPath);
    const reg = AccountRegistry.open(setup);
    reg.upsert('alice', 's3cret', join(dir, 'mail-alice.db'), { iterations: 1 });
    reg.addAlias('sales', 'alice');
    setup.close();

    const config: MailServerConfig = {
      dbPath,
      host: '127.0.0.1',
      smtpPort: 0,
      submissionPort: 0,
      imapPort: 0,
      domain: DOMAIN,
      accounts: [], // passwordless: the account lives only in the registry
      tls: { key: TEST_KEY, cert: TEST_CERT },
    };
    const server = await startServer(config);
    try {
      // The alias, a subaddress on the alias, and a subaddress on the login all deliver.
      const a = await sendTo(server.inbound.port, `sales@${DOMAIN}`, 'to the alias');
      assert.ok(a.ok, `alias delivery should succeed: ${a.failure}`);
      const b = await sendTo(server.inbound.port, `sales+q3@${DOMAIN}`, 'subaddress on alias');
      assert.ok(b.ok, `alias subaddress should succeed: ${b.failure}`);
      const c = await sendTo(server.inbound.port, `alice+github@${DOMAIN}`, 'subaddress on login');
      assert.ok(c.ok, `login subaddress should succeed: ${c.failure}`);

      // All three landed in alice's single mailbox (server.mailbox is the sole account's INBOX).
      assert.equal(server.mailbox.messages.length, 3, 'alias + both subaddresses all filed to the owner INBOX');

      // NEGATIVE CONTROL: an address that is neither a login nor an alias is refused — the
      // alias feature must not become a catch-all.
      const bad = await sendTo(server.inbound.port, `unknown@${DOMAIN}`, 'nobody');
      assert.ok(!bad.ok, 'an unknown local address is still rejected (no catch-all)');
      assert.equal(server.mailbox.messages.length, 3, 'the rejected message was not stored anywhere');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
