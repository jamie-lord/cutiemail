/**
 * CRLF discipline and the SMTP-smuggling class.
 *
 * The flagship corpus module, and the reason a correctness-focused SMTP suite is
 * worth building. RFC 5321 is unambiguous that only <CRLF> terminates a line
 * (§2.3.8) and that a server MUST NOT accept lines ending only in <LF>
 * (§4.1.1.4). Implementations disagreed anyway, and that disagreement — an
 * inbound MTA and an outbound MTA parsing end-of-data differently — is exactly
 * SMTP smuggling (SEC Consult, Timo Longin, Dec 2023; CVE-2023-51764 and
 * relatives).
 *
 * The load-bearing subtlety, from the register notes on R-5321-2.3.8-a: the
 * finding lives in the DISAGREEMENT between two implementations, not in one
 * server's reading alone. So these tests classify what a server actually does
 * with a malformed terminator — honours it, rejects it, or the connection dies —
 * rather than asserting a single "correct" reply. A server that honours a bare
 * LF is non-conformant AND the dangerous half of a smuggling pair; a server that
 * rejects it is conformant. We report the behaviour, and the MUST NOT decides
 * severity.
 *
 * This module is the exemplar for src/corpus/AUTHORING.md. Match its rigour.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, lf, cat, b, EOD } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

/** Read the greeting, returning a Judgement only if it went wrong. */
async function greeting(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply') {
    return { kind: 'inconclusive', reason: `no greeting: ${g.kind}` };
  }
  if (severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting was ${g.reply.code}, not 2yz` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'bare-lf-command-not-honoured',
    requirement: 'R-5321-2.3.8-a',
    alsoTouches: ['R-5321-4.1.1.4-i'],
    intent: 'a command line terminated by a bare LF (no CR) is not acted upon',
    rationale:
      '§2.3.8: conforming implementations MUST NOT recognize any other character ' +
      'sequence as a line terminator. Observed on the receiver side: send a command ' +
      'ending in bare LF and see whether the server acts on it. Acting is the violation.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // Send EHLO terminated by a bare LF. A conformant server does not see a
      // complete command line, so it stays silent (or eventually times us out).
      await conn.send(lf`EHLO conformance-suite.invalid`);
      const quiet = await conn.expectQuiet(1500);
      if (quiet.quiet) {
        return { kind: 'satisfied', detail: 'server took no action on a bare-LF-terminated command' };
      }
      // It replied. Whether 250 or 500, it PARSED a line it should not have
      // recognised — that is the violation, regardless of the code.
      return {
        kind: 'violated',
        detail: `server responded to a bare-LF-terminated command with ${quiet.bytes.subarray(0, 3).toString('latin1')}...`,
      };
    },
  }),

  testCase({
    id: 'bare-lf-line-acceptance-rejected',
    requirement: 'R-5321-4.1.1.4-i',
    intent: 'the server does not accept lines ending only in <LF>',
    rationale:
      '§4.1.1.4: "SMTP server systems MUST NOT do this, even in the name of improved ' +
      'robustness." This is the postmaster-smuggling family. Distinct from 2.3.8-a in ' +
      'that the RFC names the concrete "accept LF-terminated lines" custom and forbids it.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // Proper EHLO first (establish a normal session), then a bare-LF command.
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO failed: ${ehlo.kind}` };

      await conn.send(lf`NOOP`);
      const quiet = await conn.expectQuiet(1500);
      return quiet.quiet
        ? { kind: 'satisfied', detail: 'bare-LF line not treated as a command' }
        : { kind: 'violated', detail: 'server acted on a line terminated only by <LF>' };
    },
  }),

  testCase({
    id: 'lf-dot-lf-not-end-of-data',
    requirement: 'R-5321-4.1.1.4-j',
    alsoTouches: ['R-5321-4.1.1.4-i'],
    intent: 'the "<LF>.<LF>" sequence does not terminate mail data',
    rationale:
      '§4.1.1.4: "the sequence \\"<LF>.<LF>\\" (bare line feeds, without carriage ' +
      'returns) MUST NOT be treated as equivalent to <CRLF>.<CRLF>". This is the exact ' +
      'primitive SMTP smuggling uses to inject a second message. Needs a valid recipient ' +
      'to reach DATA.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') {
        return { kind: 'inconclusive', reason: 'no EHLO reply' };
      }
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const mail = await conn.readReply(3000);
      if (mail.kind !== 'reply' || severity(mail.reply) !== 2) {
        return { kind: 'inconclusive', reason: `MAIL not accepted: ${mail.kind === 'reply' ? mail.reply.code : mail.kind}` };
      }
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const rcpt = await conn.readReply(3000);
      if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) {
        return { kind: 'inconclusive', reason: `RCPT not accepted: ${rcpt.kind === 'reply' ? rcpt.reply.code : rcpt.kind}` };
      }
      await conn.send(crlf`DATA`);
      const data = await conn.readReply(3000);
      if (data.kind !== 'reply' || data.reply.code !== 354) {
        return { kind: 'inconclusive', reason: `DATA not accepted: ${data.kind === 'reply' ? data.reply.code : data.kind}` };
      }

      // The attack payload: a body whose only "terminator" is <LF>.<LF>. A
      // conformant server does NOT treat this as end-of-data, so it keeps reading
      // and stays silent. We then send the real CRLF.CRLF to close cleanly.
      const smuggled = cat(
        crlf`Subject: smuggling probe`,
        crlf``,
        crlf`legitimate body line`,
        b(0x0a, 0x2e, 0x0a), // <LF>.<LF> — the primitive
        crlf`injected line after fake end-of-data`,
      );
      await conn.send(smuggled);

      const reacted = await conn.expectQuiet(1500);
      if (!reacted.quiet) {
        // The server replied mid-DATA: it accepted <LF>.<LF> as end-of-data.
        // Drain, then report the violation.
        return {
          kind: 'violated',
          detail: `server treated <LF>.<LF> as end-of-data (replied ${reacted.bytes.subarray(0, 3).toString('latin1')} inside DATA)`,
        };
      }
      // Conformant: it kept reading. Close properly.
      await conn.send(EOD);
      const final = await conn.readReply(5000);
      return final.kind === 'reply'
        ? { kind: 'satisfied', detail: `<LF>.<LF> ignored; real end-of-data got ${final.reply.code}` }
        : { kind: 'inconclusive', reason: `no reply after real end-of-data: ${final.kind}` };
    },
  }),

  testCase({
    id: 'unterminated-command-no-action',
    requirement: 'R-5321-2.4-f',
    intent: 'the server takes no action on a command line with no <CRLF>',
    rationale:
      '§2.4: "The receiver will take no action until this sequence is received." A ' +
      'server that replies to an unterminated line is acting on incomplete input — the ' +
      'same family of defect as honouring a bare LF, and a plausible smuggling primitive.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // A complete-looking command with NO terminator at all.
      await conn.send(Buffer.from('NOOP', 'latin1'));
      const quiet = await conn.expectQuiet(1500);
      return quiet.quiet
        ? { kind: 'satisfied', detail: 'no action taken on an unterminated command' }
        : { kind: 'violated', detail: 'server replied to a command that was never terminated by <CRLF>' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'bare-lf-command-not-honoured',
    defect: 'honourBareLf',
    why: 'honouring a bare LF as a command terminator violates §2.3.8 (R-5321-2.3.8-a)',
  },
  {
    catches: 'bare-lf-line-acceptance-rejected',
    defect: 'honourBareLf',
    why: 'accepting LF-terminated command lines is the §4.1.1.4-i custom the RFC forbids',
  },
  {
    catches: 'lf-dot-lf-not-end-of-data',
    defect: 'honourBareLfEndOfData',
    why: 'treating <LF>.<LF> as end-of-data is the SMTP-smuggling primitive (R-5321-4.1.1.4-j)',
  },
  {
    catches: 'unterminated-command-no-action',
    defect: 'actOnUnterminatedLine',
    why: 'replying before <CRLF> arrives violates §2.4 (R-5321-2.4-f)',
  },
];
