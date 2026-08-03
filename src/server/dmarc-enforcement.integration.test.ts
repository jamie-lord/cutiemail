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
import { readMessages } from '../testing/read-messages.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A TXT resolver publishing DMARC records for the test sender domains; no SPF records
// (so SPF is "none") and no other TXT — everything else is empty.
const dmarcTxt = async (name: string): Promise<readonly string[]> => {
  const map: Record<string, string[]> = {
    '_dmarc.spoofer.test': ['v=DMARC1; p=quarantine'],
    '_dmarc.rejector.test': ['v=DMARC1; p=reject'],
    '_dmarc.monitor.test': ['v=DMARC1; p=none'],
    '_dmarc.gated.test': ['v=DMARC1; p=quarantine; pct=10'],
    '_dmarc.reject-gated.test': ['v=DMARC1; p=reject; pct=10'],
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
    assert.equal(readMessages(junk).length, 1, 'the quarantined message is in Junk');
    assert.equal(readMessages(inbox).length, 0, 'and NOT in the INBOX');

    await sendFrom(server.inbound.port, 'rejector.test'); // p=reject → also Junk, never hard-reject
    assert.equal(readMessages(junk).length, 2, 'p=reject failure is quarantined to Junk (not rejected)');
    assert.equal(readMessages(inbox).length, 0);
  } finally {
    await server.close();
  }
});

test('a p=none DMARC failure stays informational — delivered to the INBOX', async () => {
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    await sendFrom(server.inbound.port, 'monitor.test'); // p=none, fails
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 1, 'p=none failure goes to the INBOX');
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 0, 'not quarantined');
    // The Authentication-Results header still records the failure.
    assert.match(readMessages(alice.catalog.get('INBOX')!)[0]!.raw.toString('latin1'), /dmarc=fail/);
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
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 1, 'outside the pct sample → INBOX');
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 0);
  } finally {
    await server.close();
  }
});

test('an unsampled p=reject failure is quarantined to Junk, not delivered to the INBOX (§6.6.4)', async () => {
  // RFC 7489 §6.6.4: the pct-unsampled remainder of a p=reject policy is treated AS p=quarantine,
  // not as no policy. Under ADR 0010 both land in Junk, so a p=reject failure is Junk regardless of
  // the sample. Old behaviour gated reject on the sample too (50 < 10 is false → INBOX), delivering
  // ~90% of spoofed mail from a p=reject; pct=10 domain to the inbox — the wrong direction.
  const server = await startServer(baseConfig(() => 50)); // sample 50, above pct=10 → NOT the reject share
  try {
    const alice = server.stores.get('alice')!;
    await sendFrom(server.inbound.port, 'reject-gated.test'); // p=reject; pct=10, fails, unsampled
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 1, 'the unsampled reject failure is quarantined to Junk');
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0, 'and NOT delivered to the INBOX');
  } finally {
    await server.close();
  }
});

/**
 * The From forms below are not malformed to a reader: RFC 5322 §4.4's obs-mbox-list makes a
 * trailing comma a one-mailbox list, RFC 6854 permits group syntax in From, and obs-domain
 * permits CFWS between the domain's atoms. Reference parsers resolve every one of them to
 * `sender@rejector.test`, so that is what the recipient sees.
 *
 * Each used to produce a "domain" carrying a comma, semicolon or space. c-ares rejects such a
 * name with EBADNAME, the resolver rethrows it, discovery became temperror, and enforcement
 * only acts on `fail` — so the published p=reject was never applied and the spoof landed in the
 * INBOX. The plainer the spoof, the harsher the treatment it got.
 */
async function sendWithFrom(port: number, fromHeader: string): Promise<void> {
  await deliver(
    { host: '127.0.0.1', port, tls: 'none' },
    {
      from: 'sender@rejector.test',
      recipients: ['alice@mail.example.test'],
      data: Buffer.from(
        `From: ${fromHeader}\r\nTo: alice@mail.example.test\r\nSubject: grammar probe\r\n\r\nbody\r\n`,
        'latin1',
      ),
      clientName: 'rejector.test',
    },
  );
  await delay(150);
}

test('a p=reject spoof is quarantined for every From form a compliant parser resolves', async () => {
  const forms = [
    'sender@rejector.test', // control
    'sender@rejector.test,', // obs-mbox-list: still ONE mailbox
    'Accounts: sender@rejector.test;', // RFC 6854 group syntax
    'sender@rejector .test', // obs-domain with CFWS between atoms
  ];
  for (const form of forms) {
    const server = await startServer(baseConfig(() => 0));
    try {
      const alice = server.stores.get('alice')!;
      await sendWithFrom(server.inbound.port, form);
      assert.equal(
        readMessages(alice.catalog.get('Junk')!).length,
        1,
        `From: ${form} — the published p=reject must be discovered and applied`,
      );
      assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0, `From: ${form} — not the INBOX`);
    } finally {
      await server.close();
    }
  }
});

test('an author domain the attacker appended cannot choose the governing policy', async () => {
  // The victim's address is displayed first; the attacker's policy-less domain used to be the
  // one whose (absent) policy was fetched, so the spoof was judged a failure and then delivered.
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    await sendWithFrom(server.inbound.port, 'sender@rejector.test, attacker@nowhere.test');
    assert.equal(
      readMessages(alice.catalog.get('Junk')!).length,
      1,
      'RFC 9989 §11.5: the strictest policy among the author domains governs',
    );
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0);
  } finally {
    await server.close();
  }
});

/**
 * The structural twin of the appended-mailbox spoof above, one header up: RFC 5322 §3.6.1
 * permits exactly one From, but a message can carry several From HEADERS. Evaluating only the
 * first header's value left a p=reject victim carried in a second From header unqueried, and the
 * spoof reached the INBOX. RFC 9989 §11.5 requires every author domain — across all From headers
 * — to be weighed, and the strictest failing policy applied.
 */
async function sendRawHeaders(port: number, headerBlock: string): Promise<void> {
  await deliver(
    { host: '127.0.0.1', port, tls: 'none' },
    {
      from: 'sender@rejector.test',
      recipients: ['alice@mail.example.test'],
      data: Buffer.from(`${headerBlock}\r\nSubject: multi-from probe\r\n\r\nbody\r\n`, 'latin1'),
      clientName: 'rejector.test',
    },
  );
  await delay(150);
}

test('a p=reject victim in a SECOND From header is quarantined, whichever order the headers are in', async () => {
  for (const block of [
    'From: attacker@nowhere.test\r\nFrom: sender@rejector.test', // attacker (no policy) first
    'From: sender@rejector.test\r\nFrom: attacker@nowhere.test', // victim first
  ]) {
    const server = await startServer(baseConfig(() => 0));
    try {
      const alice = server.stores.get('alice')!;
      await sendRawHeaders(server.inbound.port, block);
      assert.equal(readMessages(alice.catalog.get('Junk')!).length, 1, `${block} — the second header's p=reject must be applied`);
      assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0, `${block} — not the INBOX`);
    } finally {
      await server.close();
    }
  }
});

test('a spoof padded with more author domains than the §11.5 budget fails safe to Junk', async () => {
  // Five distinct no-policy From headers ahead of the p=reject victim push it past
  // MAX_AUTHOR_DOMAINS. We cannot certify the message as policy-free, so a guaranteed display-spoof
  // is quarantined rather than delivered — the attacker cannot buy the INBOX by padding.
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    const pad = [1, 2, 3, 4, 5].map((n) => `From: p${n}@pad${n}.test`).join('\r\n');
    await sendRawHeaders(server.inbound.port, `${pad}\r\nFrom: sender@rejector.test`);
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 1, 'padded-past-budget spoof is quarantined');
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0);
  } finally {
    await server.close();
  }
});

test('a multi-From spoof whose author domains all genuinely publish nothing is not over-enforced', async () => {
  // Guaranteed display-spoof (two From headers), but every author domain — weighed in full,
  // within budget — publishes no policy. Like the single-From no-policy case, it stays in the
  // INBOX: the fail-safe quarantine fires only when a domain could NOT be weighed, not whenever
  // more than one From is present.
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    await sendRawHeaders(server.inbound.port, 'From: a@nowhere.test\r\nFrom: b@nowhere2.test');
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 1, 'no author domain enforces → INBOX');
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 0, 'not quarantined merely for having two From headers');
  } finally {
    await server.close();
  }
});

test('a From present but unresolvable to any author domain is quarantined, not delivered', async () => {
  const server = await startServer(baseConfig(() => 0));
  try {
    const alice = server.stores.get('alice')!;
    await sendWithFrom(server.inbound.port, 'sender@rejector.test <>');
    assert.equal(
      readMessages(alice.catalog.get('Junk')!).length,
      1,
      'a message whose author cannot be identified cannot be authenticated, so it is not trusted',
    );
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0);
  } finally {
    await server.close();
  }
});
