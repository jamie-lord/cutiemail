/**
 * Session state machine and command sequencing.
 *
 * The unambiguous, connection-level obligations: RSET/NOOP/QUIT semantics, the
 * HELO-vs-EHLO response shape, and the out-of-order command rule. These are the
 * cheapest requirements to test — no fixture, no message — and among the most
 * reliably observed, so they are where a differential run first shows a server's
 * character.
 *
 * A deliberate omission worth its own note: this module does NOT test
 * "MAIL before EHLO must be rejected". §4.1.4-k says servers SHOULD process
 * commands even with no prior EHLO, and accepting MAIL without a greeting is
 * common and conformant. Asserting it would fail good servers. The register
 * caught this; the mutant server keeps an `acceptMailBeforeGreeting` switch for
 * completeness but nothing here treats it as a violation. Only orderings that
 * genuinely "cannot be processed" (§4.1.4-o) — RCPT before MAIL, DATA before
 * RCPT — are tested.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity, ehloKeywords } from '../wire/reply.ts';

async function greetAndEhlo(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply' || severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
  }
  await conn.send(crlf`EHLO conformance-suite.invalid`);
  const e = await conn.readReply(3000);
  if (e.kind !== 'reply' || e.reply.code !== 250) {
    return { kind: 'inconclusive', reason: `EHLO: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'rset-returns-250',
    requirement: 'R-5321-4.1.1.5-b',
    intent: 'RSET with no arguments draws a 250 reply',
    rationale: '§4.1.1.5: "The receiver MUST send a \\"250 OK\\" reply to a RSET command with no arguments."',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RSET`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `RSET drew ${r.kind}, not a reply` };
      return r.reply.code === 250
        ? { kind: 'satisfied' }
        : { kind: 'violated', detail: `RSET drew ${r.reply.code}, not 250` };
    },
  }),

  testCase({
    id: 'rset-does-not-close-connection',
    requirement: 'R-5321-4.1.1.5-e',
    intent: 'the server does not close the connection in response to RSET',
    rationale:
      '§4.1.1.5: "An SMTP server MUST NOT close the connection as the result of receiving ' +
      'a RSET; that action is reserved for QUIT."',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RSET`);
      const r = await conn.readReply(3000);
      if (r.kind === 'closed' || r.kind === 'reset') {
        return { kind: 'violated', detail: `connection ${r.kind} after RSET` };
      }
      // Prove it is still usable: a following NOOP should also answer.
      await conn.send(crlf`NOOP`);
      const n = await conn.readReply(3000);
      return n.kind === 'reply'
        ? { kind: 'satisfied' }
        : { kind: 'violated', detail: `connection unusable after RSET (NOOP got ${n.kind})` };
    },
  }),

  testCase({
    id: 'noop-returns-250',
    requirement: 'R-5321-4.1.1.9-b',
    intent: 'NOOP draws a 250 reply',
    rationale: '§4.1.1.9: NOOP "specifies no action other than that the receiver send a \\"250 OK\\" reply."',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`NOOP`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `NOOP drew ${r.kind}` };
      return r.reply.code === 250
        ? { kind: 'satisfied' }
        : { kind: 'violated', detail: `NOOP drew ${r.reply.code}, not 250` };
    },
  }),

  testCase({
    id: 'quit-returns-221-and-closes',
    requirement: 'R-5321-4.1.1.10-a',
    intent: 'QUIT draws a 221 reply and the server then closes the channel',
    rationale: '§4.1.1.10: QUIT "specifies that the receiver MUST send a \\"221 OK\\" reply, and then close the transmission channel."',
    run: async (conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply') return { kind: 'inconclusive', reason: `greeting: ${g.kind}` };
      await conn.send(crlf`QUIT`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `QUIT drew ${r.kind}, not a reply` };
      if (r.reply.code !== 221) return { kind: 'violated', detail: `QUIT drew ${r.reply.code}, not 221` };
      // The server should now close. Reading again should observe the close.
      const after = await conn.readReply(3000);
      return after.kind === 'closed' || after.kind === 'reset'
        ? { kind: 'satisfied', detail: '221 then close' }
        : { kind: 'violated', detail: `server did not close after 221 (got ${after.kind})` };
    },
  }),

  testCase({
    id: 'helo-not-given-extended-response',
    requirement: 'R-5321-3.2-b',
    intent: 'HELO draws a single-line reply, not an EHLO-style multiline response',
    rationale: '§3.2: "Servers MUST NOT return the extended EHLO-style response to a HELO command."',
    run: async (conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`HELO conformance-suite.invalid`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `HELO drew ${r.kind}` };
      if (r.reply.code !== 250) {
        return { kind: 'inconclusive', reason: `HELO refused with ${r.reply.code} (server may not support HELO)` };
      }
      // The violation: a multiline reply advertising extensions, EHLO-style.
      if (r.reply.multiline && ehloKeywords(r.reply).size > 0) {
        return {
          kind: 'violated',
          detail: `HELO drew an EHLO-style multiline reply advertising ${[...ehloKeywords(r.reply)].join(', ')}`,
        };
      }
      return { kind: 'satisfied', detail: 'HELO drew a single-line 250' };
    },
  }),

  testCase({
    id: 'rcpt-before-mail-rejected',
    requirement: 'R-5321-4.1.4-o',
    intent: 'RCPT with no prior MAIL draws a 503 (out of order, cannot be processed)',
    rationale:
      '§4.1.4: "If the commands in a transaction are out of order to the degree that they ' +
      'cannot be processed by the server, a 503 failure reply MUST be returned." RCPT with ' +
      'no reverse-path buffer is the canonical case.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RCPT TO:<someone@example.com>`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `RCPT-before-MAIL drew ${r.kind}` };
      // The RFC says 503 specifically, but assert the class as the firm floor:
      // any 5yz rejection satisfies "cannot be processed"; a 2yz acceptance is
      // the violation. (503 exact is checked as a detail, not the pass/fail.)
      return severity(r.reply) === 5
        ? { kind: 'satisfied', detail: `RCPT-before-MAIL rejected with ${r.reply.code}` }
        : { kind: 'violated', detail: `RCPT-before-MAIL drew ${r.reply.code}, not a 5yz rejection` };
    },
  }),

  testCase({
    id: 'data-before-rcpt-rejected',
    requirement: 'R-5321-4.1.4-o',
    intent: 'DATA with no accepted RCPT draws a 5yz (out of order, no recipients)',
    rationale:
      '§4.1.4-o: DATA with an empty recipient buffer cannot be processed and MUST draw a ' +
      '503 (asserted as any 5yz — the firm floor).',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const mail = await conn.readReply(3000);
      if (mail.kind !== 'reply' || severity(mail.reply) !== 2) {
        return { kind: 'inconclusive', reason: `MAIL not accepted: ${mail.kind === 'reply' ? mail.reply.code : mail.kind}` };
      }
      await conn.send(crlf`DATA`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `DATA-before-RCPT drew ${r.kind}` };
      if (r.reply.code === 354) {
        return { kind: 'violated', detail: 'server entered DATA mode with no accepted recipient' };
      }
      return severity(r.reply) === 5
        ? { kind: 'satisfied', detail: `DATA-before-RCPT rejected with ${r.reply.code}` }
        : { kind: 'violated', detail: `DATA-before-RCPT drew ${r.reply.code}, not a 5yz` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  { catches: 'rset-returns-250', defect: 'rsetWrongReply', why: 'a non-250 reply to RSET violates R-5321-4.1.1.5-b' },
  { catches: 'rset-does-not-close-connection', defect: 'rsetClosesConnection', why: 'closing on RSET violates R-5321-4.1.1.5-e' },
  { catches: 'noop-returns-250', defect: 'noopWrongReply', why: 'a non-250 reply to NOOP violates R-5321-4.1.1.9-b' },
  { catches: 'quit-returns-221-and-closes', defect: 'quitWrongReply', why: 'a non-221 reply to QUIT violates R-5321-4.1.1.10-a' },
  { catches: 'helo-not-given-extended-response', defect: 'extendedResponseToHelo', why: 'an EHLO-style reply to HELO violates R-5321-3.2-b' },
  { catches: 'rcpt-before-mail-rejected', defect: 'acceptRcptBeforeMail', why: 'accepting RCPT before MAIL violates R-5321-4.1.4-o' },
  { catches: 'data-before-rcpt-rejected', defect: 'acceptDataBeforeRcpt', why: 'entering DATA with no recipient violates R-5321-4.1.4-o' },
];
