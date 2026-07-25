/**
 * A message whose header section exceeds the parser's caps must be REFUSED, not authenticated.
 *
 * The parser bounds the header section (MAX_HEADERS fields / MAX_HEADER_SECTION_BYTES) so that a
 * field folded across millions of continuation lines cannot exhaust memory. Past either cap it
 * stops materialising fields — silently, because the anomalies it records are read by nothing.
 *
 * That turns a DoS cap into an authentication bypass. Every inbound trust decision (DKIM, DMARC,
 * ARC) and the submission send-as gate reason over the materialised header list, while the bytes
 * we store and later serve to a client via BODY[] / RFC822.HEADER are uncapped. An anonymous peer
 * that pads the header section past the cap hides the real From: from authentication but not from
 * the MUA: DMARC reports `none`, a p=reject spoof lands in the INBOX, and the client renders the
 * spoofed sender.
 *
 * These tests pin BOTH halves: the refusal, and the control proving DMARC still enforces on the
 * same spoof without the padding (so a test that passes because nothing is delivered at all would
 * be caught).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { readMessages } from '../testing/read-messages.ts';
import { parseMessage, MAX_HEADERS, MAX_HEADER_SECTION_BYTES } from '../message/parse.ts';
import { ensureSubmissionHeaders } from './submission-fixup.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dmarcTxt = async (name: string): Promise<readonly string[]> => {
  const map: Record<string, string[]> = { '_dmarc.rejector.test': ['v=DMARC1; p=reject'] };
  return map[name.toLowerCase()] ?? [];
};

function baseConfig(): MailServerConfig {
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
    dkimKeyResolver: async () => null, // no DKIM key → alignment genuinely fails
    dmarcPctSampler: () => 0, // always within pct, so p=reject is always enforced
  };
}

/** A spoof of a p=reject domain, optionally preceded by `pad` minimal header fields. */
const spoof = (pad: number, subject: string): Buffer =>
  Buffer.from(
    'a:\r\n'.repeat(pad) +
      'From: "Finance Dept" <ceo@rejector.test>\r\n' +
      'To: alice@mail.example.test\r\n' +
      `Subject: ${subject}\r\n\r\n` +
      'Please wire the money.\r\n',
    'latin1',
  );

test('the header-section caps are exposed on the parse result, not just as an unread anomaly', () => {
  const clean = parseMessage(spoof(0, 'clean'));
  assert.equal(clean.headersTruncated, false);

  // Field-count cap.
  const byCount = parseMessage(spoof(MAX_HEADERS, 'by-count'));
  assert.equal(byCount.headersTruncated, true, 'MAX_HEADERS sets headersTruncated');
  assert.equal(
    byCount.headers.some((h) => h.name.toString('latin1').toLowerCase() === 'from'),
    false,
    'and the real From is indeed invisible to every parseMessage consumer',
  );

  // Byte cap, reached through ONE folded field so the field count never trips.
  const folded = Buffer.from(
    `X-Pad: ${'\r\n '.repeat(Math.ceil(MAX_HEADER_SECTION_BYTES / 3) + 10)}\r\nFrom: <ceo@rejector.test>\r\n\r\nbody\r\n`,
    'latin1',
  );
  const byBytes = parseMessage(folded);
  assert.equal(byBytes.headersTruncated, true, 'MAX_HEADER_SECTION_BYTES sets headersTruncated too');
});

test('inbound: a spoof hidden behind the header-count cap is refused, while the same spoof unpadded is quarantined', async () => {
  const server = await startServer(baseConfig());
  try {
    const alice = server.stores.get('alice')!;
    const inbox = alice.catalog.get('INBOX')!;
    const junk = alice.catalog.get('Junk')!;
    const send = (data: Buffer): ReturnType<typeof deliver> =>
      deliver(
        { host: '127.0.0.1', port: server.inbound.port, tls: 'none' },
        { from: 'anything@one.example', recipients: ['alice@mail.example.test'], data, clientName: 'one.example' },
      );

    // CONTROL: without padding, DMARC enforcement works — accepted, filed to Junk.
    const control = await send(spoof(0, 'control'));
    assert.equal(control.ok, true, 'the unpadded spoof is accepted');
    await delay(150);
    assert.equal(readMessages(junk).length, 1, 'and correctly quarantined by p=reject');
    assert.equal(readMessages(inbox).length, 0);

    // ATTACK: the same spoof with the From pushed past MAX_HEADERS is refused outright.
    const attack = await send(spoof(MAX_HEADERS, 'attack'));
    assert.equal(attack.ok, false, 'the padded spoof is NOT accepted');
    assert.equal(attack.dataCode, 550, 'it is refused permanently at end-of-DATA');
    await delay(150);
    assert.equal(readMessages(inbox).length, 0, 'nothing reached the INBOX');
    assert.equal(readMessages(junk).length, 1, 'and nothing new reached Junk either');
  } finally {
    await server.close();
  }
});

test('submission: the fix-up refuses a truncated parse rather than synthesizing a From over a hidden one', () => {
  // Unpadded: a From-less message legitimately gets the envelope sender synthesized in.
  const plain = ensureSubmissionHeaders(Buffer.from('Subject: x\r\n\r\nbody\r\n', 'latin1'), 'mail.example.test', 'alice@mail.example.test');
  assert.notEqual(plain, null);
  assert.match(plain!.toString('latin1'), /From: <alice@mail\.example\.test>/);

  // Padded: the sender's real From sits past the cap. Synthesizing an owned From here would hand
  // the send-as gate a single owned address to approve, and ship the message DKIM-signed with two
  // From headers — ours above the attacker's.
  const hidden = Buffer.from(
    'a:\r\n'.repeat(MAX_HEADERS) + 'From: "Your Bank" <security@bank.test>\r\n\r\nbody\r\n',
    'latin1',
  );
  assert.equal(
    ensureSubmissionHeaders(hidden, 'mail.example.test', 'alice@mail.example.test'),
    null,
    'a truncated parse must refuse, not synthesize',
  );
});
