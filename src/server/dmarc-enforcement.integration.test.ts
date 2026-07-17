/**
 * Inbound DMARC enforcement (ADR 0010): a message that FAILS DMARC is filed to Junk when
 * the owner published p=quarantine/p=reject, delivered to the INBOX when p=none (purely
 * informational), and the pct tag gates the share of failures acted on. Driven end to end
 * through the daemon with injected DNS (a published DMARC record, no DKIM key, no SPF), so
 * the messages genuinely fail alignment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A TXT resolver publishing DMARC records for the test sender domains; no SPF records
// (so SPF is "none") and no other TXT — everything else is empty.
const dmarcTxt = async (name: string): Promise<readonly string[]> => {
  const map: Record<string, string[]> = {
    '_dmarc.spoofer.test': ['v=DMARC1; p=quarantine'],
    '_dmarc.rejector.test': ['v=DMARC1; p=reject'],
    '_dmarc.monitor.test': ['v=DMARC1; p=none'],
    '_dmarc.gated.test': ['v=DMARC1; p=quarantine; pct=10'],
  };
  return map[name.toLowerCase()] ?? [];
};

function baseConfig(sampler: () => number): MailServerConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'alice', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    spfResolvers: { txt: dmarcTxt, a: async () => [], mx: async () => [] },
    dkimKeyResolver: async () => null, // no DKIM key → no aligned DKIM pass
    dmarcPctSampler: sampler,
  };
}

async function sendFrom(port: number, fromDomain: string): Promise<void> {
  const from = `sender@${fromDomain}`;
  await deliver(
    { host: '127.0.0.1', port, tls: 'none' },
    { from, recipients: ['alice@mail.example.test'], data: Buffer.from(`From: ${from}\r\nTo: alice@mail.example.test\r\nSubject: probe-${fromDomain}\r\n\r\nbody\r\n`, 'latin1'), clientName: fromDomain },
  );
  await delay(150);
}

test('a p=quarantine (and p=reject) DMARC failure is filed to Junk, not the INBOX', async () => {
  const server = await startServer(baseConfig(() => 0)); // sample 0 → always within pct
  try {
    const alice = server.stores.get('alice')!;
    const inbox = alice.catalog.get('INBOX')!;
    const junk = alice.catalog.get('Junk')!;

    await sendFrom(server.inbound.port, 'spoofer.test'); // p=quarantine, fails
    assert.equal(junk.messages.length, 1, 'the quarantined message is in Junk');
    assert.equal(inbox.messages.length, 0, 'and NOT in the INBOX');

    await sendFrom(server.inbound.port, 'rejector.test'); // p=reject → also Junk, never hard-reject
    assert.equal(junk.messages.length, 2, 'p=reject failure is quarantined to Junk (not rejected)');
    assert.equal(inbox.messages.length, 0);
  } finally {
    await server.close();
  }
});

test('a p=none DMARC failure stays informational — delivered to the INBOX', async () => {
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    await sendFrom(server.inbound.port, 'monitor.test'); // p=none, fails
    assert.equal(alice.catalog.get('INBOX')!.messages.length, 1, 'p=none failure goes to the INBOX');
    assert.equal(alice.catalog.get('Junk')!.messages.length, 0, 'not quarantined');
    // The Authentication-Results header still records the failure.
    assert.match(alice.catalog.get('INBOX')!.messages[0]!.raw.toString('latin1'), /dmarc=fail/);
  } finally {
    await server.close();
  }
});

test('pct gates enforcement: a sample at or above pct leaves the failure in the INBOX', async () => {
  // Record pct=10; sampler returns 50 → 50 < 10 is false → policy NOT applied this time.
  const server = await startServer(baseConfig(() => 50));
  try {
    const alice = server.stores.get('alice')!;
    await sendFrom(server.inbound.port, 'gated.test'); // p=quarantine; pct=10, fails, but not sampled
    assert.equal(alice.catalog.get('INBOX')!.messages.length, 1, 'outside the pct sample → INBOX');
    assert.equal(alice.catalog.get('Junk')!.messages.length, 0);
  } finally {
    await server.close();
  }
});
