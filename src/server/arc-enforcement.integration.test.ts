/**
 * ARC override of DMARC enforcement (RFC 8617 + ADR 0010/ARC): a message that fails DMARC
 * (p=reject/quarantine) and would be filed to Junk is instead delivered to the INBOX when it
 * carries a valid ARC chain sealed by a forwarder we TRUST. This is the scenario ARC exists
 * for: a mailing list rewrites the message (breaking the author's DKIM and misaligning SPF),
 * but seals that the message authenticated cleanly when it entered the list.
 *
 * Driven end to end through the daemon with injected DNS: the author domain publishes
 * p=reject and no DKIM key (so DMARC genuinely fails), and the trusted list's ARC key is
 * published so the chain verifies. The trust list is the load-bearing control — the SAME
 * valid chain from an UNtrusted sealer, and a TAMPERED chain from a trusted sealer, both
 * stay in Junk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { makeArcSigner, addArcSet, arcResolver, rawMessageOf, type HeaderLine } from '../testing/arc-sealer.ts';
import { readMessages } from '../testing/read-messages.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The author domain publishes p=reject; nothing else resolves (no SPF, no DKIM) so the
// message fails DMARC and — absent ARC — would be quarantined.
const dmarcTxt = async (name: string): Promise<readonly string[]> =>
  name.toLowerCase() === '_dmarc.author.test' ? ['v=DMARC1; p=reject'] : [];

const AUTHOR_HEADERS: readonly HeaderLine[] = [
  { name: 'From', value: 'Author <author@author.test>' },
  { name: 'To', value: 'list@list.test' },
  { name: 'Subject', value: 'discussion thread' },
  { name: 'Date', value: 'Wed, 15 Jul 2026 12:00:00 +0000' },
];
const BODY = 'A message that traversed a mailing list.\r\n';

/** The list (list.test) seals the author's message with a valid one-hop ARC chain. */
const listSigner = makeArcSigner('list.test', 'arc2026', 'rsa');
const sealedMessage = (): Buffer => {
  const hop = addArcSet(AUTHOR_HEADERS, BODY, listSigner, 1, 'none', 'dmarc=pass', []);
  return rawMessageOf([...hop.lines, ...AUTHOR_HEADERS], BODY);
};

function config(trusted: readonly string[]): MailServerConfig {
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
    // The DKIM resolver doubles as the ARC key resolver: the author has no DKIM key, but
    // the list's ARC key is published so its seal verifies.
    dkimKeyResolver: arcResolver(listSigner),
    dmarcPctSampler: () => 0, // always within pct → the failure is acted on
    trustedArcSealers: trusted,
  };
}

async function send(port: number, data: Buffer): Promise<void> {
  await deliver(
    { host: '127.0.0.1', port, tls: 'none' },
    { from: 'bounces@list.test', recipients: ['alice@mail.example.test'], data, clientName: 'list.test' },
  );
  await delay(150);
}

test('a valid ARC chain from a TRUSTED list rescues a DMARC-reject failure to the INBOX', async () => {
  const server = await startServer(config(['list.test']));
  try {
    const alice = server.stores.get('alice')!;
    await send(server.inbound.port, sealedMessage());
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 1, 'rescued to the INBOX by the trusted ARC seal');
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 0, 'not quarantined');
    const stored = readMessages(alice.catalog.get('INBOX')!)[0]!.raw.toString('latin1');
    assert.match(stored, /dmarc=fail/, 'DMARC still recorded as failed');
    assert.match(stored, /arc=pass/, 'ARC recorded as pass in Authentication-Results');
  } finally {
    await server.close();
  }
});

test('NEGATIVE: the SAME valid chain from an UNtrusted sealer stays in Junk (trust is load-bearing)', async () => {
  const server = await startServer(config([])); // trust nobody
  try {
    const alice = server.stores.get('alice')!;
    await send(server.inbound.port, sealedMessage());
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 1, 'an untrusted (though valid) chain does not override DMARC');
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0);
    // The chain still validated — arc=pass is recorded even though it was not acted on.
    assert.match(readMessages(alice.catalog.get('Junk')!)[0]!.raw.toString('latin1'), /arc=pass/);
  } finally {
    await server.close();
  }
});

test('NEGATIVE: a TAMPERED chain from a trusted sealer stays in Junk (cv=fail → no rescue)', async () => {
  const server = await startServer(config(['list.test']));
  try {
    const alice = server.stores.get('alice')!;
    // Flip a byte of the body after sealing → the newest AMS no longer verifies → cv=fail.
    const tampered = sealedMessage().toString('latin1').replace('traversed', 'tampered!');
    await send(server.inbound.port, Buffer.from(tampered, 'latin1'));
    assert.equal(readMessages(alice.catalog.get('Junk')!).length, 1, 'a broken chain cannot rescue');
    assert.equal(readMessages(alice.catalog.get('INBOX')!).length, 0);
    assert.match(readMessages(alice.catalog.get('Junk')!)[0]!.raw.toString('latin1'), /arc=fail/);
  } finally {
    await server.close();
  }
});
