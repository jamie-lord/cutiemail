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
    needs: { sink: true },
    run: async (conn): Promise<Judgement> => {
      const recipient = 'Mixed.Case@example.com';
      const got = await deliverAndCapture(conn, recipient, Buffer.from('body', 'latin1'));
      if ('kind' in got) return got;
      const localParts = got.recipients.map((a) => a.slice(0, a.lastIndexOf('@')));
      return localParts.includes('Mixed.Case')
        ? { kind: 'satisfied', detail: 'recipient local-part case preserved on delivery' }
        : { kind: 'violated', detail: `delivered recipient local-part(s) ${JSON.stringify(localParts)} did not preserve the sent "Mixed.Case" — the case was folded` };
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
    catches: 'local-part-case-preserved-on-delivery',
    defect: 'lowercaseLocalPartOnRelay',
    why: 'folding the recipient local-part case on relay violates R-5321-2.4-d (implementations MUST preserve local-part case)',
  },
];
