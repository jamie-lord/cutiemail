/**
 * Delivery-path transparency — the requirements that are invisible from the
 * client side and only become observable at a receiving SINK the server relays
 * to (decision 0005). Each case drives the server to accept and relay a crafted
 * message, then reads back what the sink received.
 *
 * These declare `needs: { sink: true }`: against a plain run with no sink they are
 * inconclusive, never a false finding. The mutant relay harness
 * (verifySinkControls) supplies a sink and proves each both ways; a real server
 * needs to be configured to relay to our sink (a calibration-time concern).
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import type { SinkMessage } from '../conformance/sink.ts';
import { crlf, cat, dotStuff, EOD } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

/**
 * Drive greeting -> EHLO -> MAIL -> RCPT -> DATA -> body+end-of-data, then wait
 * for the relayed message at the sink. Returns the delivered SinkMessage, or a
 * Judgement (always inconclusive) explaining why delivery could not be observed.
 */
async function deliverAndCapture(conn: Conn, recipient: string, stuffedBody: Buffer): Promise<SinkMessage | Judgement> {
  if (conn.sink === undefined) return { kind: 'inconclusive', reason: 'no sink configured' };
  const before = conn.sink.received.length;

  const g = await conn.readReply(5000);
  if (g.kind !== 'reply' || severity(g.reply) !== 2) return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
  await conn.send(crlf`EHLO conformance-suite.invalid`);
  const e = await conn.readReply(3000);
  if (e.kind !== 'reply' || e.reply.code !== 250) return { kind: 'inconclusive', reason: `EHLO: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
  await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
  const m = await conn.readReply(3000);
  if (m.kind !== 'reply' || severity(m.reply) !== 2) return { kind: 'inconclusive', reason: `MAIL: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
  await conn.send(crlf`RCPT TO:<${recipient}>`);
  const r = await conn.readReply(3000);
  if (r.kind !== 'reply' || severity(r.reply) !== 2) return { kind: 'inconclusive', reason: `RCPT not accepted: ${r.kind === 'reply' ? r.reply.code : r.kind}` };
  await conn.send(crlf`DATA`);
  const d = await conn.readReply(3000);
  if (d.kind !== 'reply' || d.reply.code !== 354) return { kind: 'inconclusive', reason: `DATA: ${d.kind === 'reply' ? d.reply.code : d.kind}` };
  await conn.send(cat(stuffedBody, EOD));
  const final = await conn.readReply(5000);
  if (final.kind !== 'reply' || severity(final.reply) !== 2) return { kind: 'inconclusive', reason: `end-of-data: ${final.kind === 'reply' ? final.reply.code : final.kind} — not accepted for delivery` };

  const msgs = await conn.sink.waitFor(before + 1, 3000);
  const delivered = msgs[before];
  if (delivered === undefined) return { kind: 'inconclusive', reason: 'the message was accepted but nothing arrived at the sink within the timeout' };
  return delivered;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'data-transparency-dot-unstuffed',
    requirement: 'R-5321-4.5.2-c',
    intent: 'a body line beginning with a dot is delivered with the transport-added dot removed',
    rationale:
      '§4.5.2 (the RECEIVER half, R-5321-4.5.2-c — 4.5.2-a is the client\'s stuffing duty): "If the ' +
      'first character is a period and there are other characters on the line, the first character ' +
      'is deleted." The receiver un-stuffs. Invisible from the client side, so ' +
      'so we relay a body whose first line is ".secret" (sent dot-stuffed as "..secret") and read ' +
      'it back at the sink: a conformant server delivers ".secret"; one that forgot to un-stuff ' +
      'delivers "..secret".',
    needs: { sink: true, fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const body = Buffer.from('.secret leading dot\r\nan ordinary line', 'latin1');
      const got = await deliverAndCapture(conn, conn.fixture.validRecipient!, dotStuff(body));
      if ('kind' in got) return got; // inconclusive
      // Assert the un-stuffing PROPERTY, tolerant of a prepended trace header: a
      // conformant relay is REQUIRED to prepend a Received: line (§4.4), which lands
      // in the delivered content, so exact whole-body equality would false-positive
      // Postfix/Exim. Instead: the un-stuffed line must appear (single dot) and the
      // still-stuffed form must NOT (double dot). Neither found -> the body was
      // transformed some other way; do not convict.
      const lines = got.data.toString('latin1').split('\r\n');
      const stuffedStillPresent = lines.includes('..secret leading dot');
      const unstuffedPresent = lines.includes('.secret leading dot');
      if (stuffedStillPresent) {
        return { kind: 'violated', detail: 'the delivered body still carries the doubled transport dot ("..secret leading dot") — the receiver did not un-stuff' };
      }
      if (unstuffedPresent) {
        return { kind: 'satisfied', detail: 'leading transport dot correctly removed on delivery' };
      }
      return { kind: 'inconclusive', reason: `neither the un-stuffed nor the doubled line appeared in the delivered body (${JSON.stringify(got.data.toString('latin1').slice(0, 120))}) — some other transform; not convicting` };
    },
  }),

  testCase({
    id: 'received-trace-inserted-on-relay',
    requirement: 'R-5321-4.4-a',
    intent: 'a relayed message is delivered with a Received: trace line prepended',
    rationale:
      '§4.4: "When an SMTP server receives a message for delivery or further processing, it MUST ' +
      'insert trace (\\"time stamp\\" or \\"Received\\") information at the beginning of the message ' +
      'content." Invisible from the client side, but observable at the sink: the delivered content ' +
      'begins with a Received: header. We assert only the PRESENCE of a Received: line in the ' +
      'delivered header block, not its exact format (§4.4-b..f detail the internals; a server may ' +
      'vary them) nor that it is the literal first line — a conformant server MAY prepend a ' +
      'Return-Path: at final delivery (§4.4), so a strict first-line check would false-positive it.',
    needs: { sink: true, fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const got = await deliverAndCapture(conn, conn.fixture.validRecipient!, Buffer.from('a message body', 'latin1'));
      if ('kind' in got) return got;
      // The header block is everything before the first blank line (or the whole
      // content if there is none). A conformant relay inserts a Received: line here.
      const headerBlock = got.data.toString('latin1').split('\r\n\r\n')[0] ?? '';
      return /^Received:/im.test(headerBlock)
        ? { kind: 'satisfied', detail: 'delivered content carries a Received: trace line in the header block' }
        : { kind: 'violated', detail: `delivered content has no Received: line in its header block (${JSON.stringify(headerBlock.slice(0, 100))}) — no trace inserted` };
    },
  }),

  testCase({
    id: 'control-chars-delivered',
    requirement: 'R-5321-4.5.2-e',
    intent: 'control characters in the body (HT, VT) survive to delivery',
    rationale:
      '§4.5.2: "All characters are to be delivered to the recipient\'s mailbox, including spaces, ' +
      'vertical and horizontal tabs, and other control characters." A server MUST NOT strip them. ' +
      'Invisible from the client side; we relay a body containing a horizontal tab (0x09) and a ' +
      'vertical tab (0x0b) and confirm both survive in the delivered content.',
    needs: { sink: true, fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const body = Buffer.from('col1\tcol2\x0bvtab', 'latin1'); // HT 0x09 and VT 0x0b
      const got = await deliverAndCapture(conn, conn.fixture.validRecipient!, dotStuff(body));
      if ('kind' in got) return got;
      // Check the BODY only, NOT the whole delivered message. A conformant relay
      // prepends a Received: trace whose folded header continuations routinely
      // contain a horizontal tab (0x09) — scanning the full message would let that
      // trace tab MASK a genuine strip of the body's tab (a false negative). The
      // body is everything after the first blank line (or the whole thing if the
      // server inserted no header block).
      const full = got.data.toString('latin1');
      const sep = full.indexOf('\r\n\r\n');
      const deliveredBody = sep >= 0 ? full.slice(sep + 4) : full;
      const hasHT = deliveredBody.includes('\t');
      const hasVT = deliveredBody.includes('\x0b');
      return hasHT && hasVT
        ? { kind: 'satisfied', detail: 'horizontal and vertical tabs delivered intact in the body' }
        : { kind: 'violated', detail: `delivered body dropped control characters (HT present: ${hasHT}, VT present: ${hasVT}) — §4.5.2 requires all characters be delivered` };
    },
  }),

  testCase({
    id: 'local-part-case-preserved-on-delivery',
    requirement: 'R-5321-2.4-d',
    intent: 'the case of the recipient local-part is preserved through to delivery',
    rationale:
      '§2.4: "SMTP implementations MUST take care to preserve the case of mailbox local-parts" ' +
      '(R-5321-2.4-d, the PRESERVE-on-relay duty; 2.4-c is the treat-as-case-sensitive duty). A ' +
      'server MUST NOT fold the local-part case as it relays. Invisible from the client side, so we relay to a ' +
      'mixed-case local-part and read the recipient back at the sink: a conformant server ' +
      'preserves "Mixed.Case"; one that lowercases it delivers "mixed.case". The domain is ' +
      'case-insensitive (§2.3.4) and not asserted.',
    needs: { sink: true, fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      // A mixed-case spelling of the DECLARED valid recipient, so the probe rides a
      // recipient the server actually routes (its own domain) rather than a
      // hardcoded example.com a relay-restricting server would 550 straight to
      // inconclusive. Capitalise the local-part's first letter; if the fixture's
      // local-part offers no letter to flip, we cannot construct a case variant and
      // gate to inconclusive. Against a strictly case-SENSITIVE server that treats
      // the variant as a different (unknown) mailbox, the capture is inconclusive,
      // never a finding.
      const vr = conn.fixture.validRecipient!;
      const at = vr.lastIndexOf('@');
      const local = vr.slice(0, at);
      const domain = vr.slice(at);
      const mixedLocal = local.charAt(0).toUpperCase() + local.slice(1);
      if (mixedLocal === local) {
        return { kind: 'inconclusive', reason: `validRecipient local-part "${local}" has no lowercase first letter to flip; cannot construct a case-variant probe` };
      }
      const got = await deliverAndCapture(conn, `${mixedLocal}${domain}`, Buffer.from('body', 'latin1'));
      if ('kind' in got) return got;
      const localParts = got.recipients.map((a) => a.slice(0, a.lastIndexOf('@')));
      return localParts.includes(mixedLocal)
        ? { kind: 'satisfied', detail: `recipient local-part case preserved on delivery ("${mixedLocal}")` }
        : { kind: 'violated', detail: `delivered recipient local-part(s) ${JSON.stringify(localParts)} did not preserve the sent "${mixedLocal}" — the case was folded` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'data-transparency-dot-unstuffed',
    defect: 'dontUnstuffOnRelay',
    why: 'forwarding a body with the transport dot still doubled violates R-5321-4.5.2-c (the receiver deletes the leading period)',
  },
  {
    catches: 'control-chars-delivered',
    defect: 'stripControlCharsOnRelay',
    why: 'stripping horizontal/vertical tabs from the relayed body violates R-5321-4.5.2-e (all characters, including control characters, are delivered)',
  },
  {
    catches: 'received-trace-inserted-on-relay',
    defect: 'dontPrependReceived',
    why: 'relaying a message without prepending a Received: trace line violates R-5321-4.4-a (MUST insert trace information at the beginning)',
  },
  {
    catches: 'local-part-case-preserved-on-delivery',
    defect: 'lowercaseLocalPartOnRelay',
    why: 'folding the recipient local-part case on relay violates R-5321-2.4-d (implementations MUST preserve local-part case)',
  },
];
