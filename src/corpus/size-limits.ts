/**
 * Size and line-length minimums (RFC 5321 §4.5.3.1).
 *
 * The section fixes FLOORS a server must accept, not ceilings it must enforce:
 * a 512-octet command line and a 1000-octet text line MUST be processable. The
 * violation is a server whose buffers are too small — it rejects input that is
 * within the mandated minimum. A server that accepts MORE than the floor is
 * conformant, so these tests only ever fail a server for rejecting too EARLY.
 *
 * Most of §4.5.3.1 is fixture-gated: testing "a 64-octet local-part MUST be
 * accepted" needs a valid 64-octet recipient, because a plain 550 "no such user"
 * is a conformant answer and only a 5yz *syntax/length* rejection is the
 * violation — a distinction we cannot draw without knowing the address is
 * otherwise valid. Those cases declare the fixture and yield inconclusive
 * without it. Two cases are fixture-free: command-line and text-line length,
 * where the length itself is the whole test.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, cat, rep, EOD, bare, CRLF } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

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
    id: 'command-line-512-accepted',
    requirement: 'R-5321-4.5.3.1.4-a',
    intent: 'a 512-octet command line is processed, not rejected as too long',
    rationale:
      '§4.5.3.1.4: "The maximum total length of a command line including the command word ' +
      'and the <CRLF> is 512 octets." A server MUST accept up to this; rejecting a ' +
      '512-octet line for length is the violation. Uses a NOOP padded with a long ' +
      'argument — §4.1.1.9 says servers SHOULD ignore NOOP parameters, so this stays a ' +
      'pure length test.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;

      // Baseline: a SHORT NOOP with an argument. This isolates length from
      // argument handling — a server MAY reject NOOP-with-args (§4.1.1.9-e is a
      // SHOULD to ignore them). If the short one is refused, this server declines
      // that latitude, and the length test cannot distinguish length-rejection
      // from argument-rejection, so it is inconclusive rather than a false fail.
      await conn.send(cat(bare`NOOP `, rep(0x78, 8), CRLF));
      const shortReply = await conn.readReply(3000);
      if (shortReply.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `short NOOP-with-arg drew ${shortReply.kind}` };
      }
      if (shortReply.reply.code !== 250) {
        return {
          kind: 'inconclusive',
          reason:
            `server rejects NOOP-with-argument (short one drew ${shortReply.reply.code}); ` +
            `cannot separate length from argument handling — needs a length-only probe`,
        };
      }

      // The short NOOP-with-arg succeeded, so this server ignores NOOP args. Now
      // the only difference at 512 octets is the LENGTH. "NOOP " (5) + arg + CRLF
      // (2) = 512  ->  arg = 505 octets.
      await conn.send(cat(bare`NOOP `, rep(0x78, 512 - 5 - 2), CRLF));
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `512-octet command drew ${r.kind}` };
      if (r.reply.code === 250) return { kind: 'satisfied', detail: '512-octet command accepted' };
      // The short version succeeded and the 512 version did not: the length is
      // the only variable, so this is a length rejection = violation.
      return {
        kind: 'violated',
        detail: `512-octet command drew ${r.reply.code} where an 8-octet-arg NOOP drew 250 — rejected for length (a server MUST accept command lines to 512 octets)`,
      };
    },
  }),

  testCase({
    id: 'text-line-1000-accepted',
    requirement: 'R-5321-4.5.3.1.6-a',
    intent: 'a 1000-octet text line in DATA is accepted',
    rationale:
      '§4.5.3.1.6: "The maximum total length of a text line including the <CRLF> is 1000 ' +
      'octets." A server MUST accept message text lines up to this length; rejecting a ' +
      'compliant-length line is the violation. Needs a valid recipient to reach DATA.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const mail = await conn.readReply(3000);
      if (mail.kind !== 'reply' || severity(mail.reply) !== 2) {
        return { kind: 'inconclusive', reason: `MAIL: ${mail.kind === 'reply' ? mail.reply.code : mail.kind}` };
      }
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const rcpt = await conn.readReply(3000);
      if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) {
        return { kind: 'inconclusive', reason: `RCPT: ${rcpt.kind === 'reply' ? rcpt.reply.code : rcpt.kind}` };
      }
      await conn.send(crlf`DATA`);
      const data = await conn.readReply(3000);
      if (data.kind !== 'reply' || data.reply.code !== 354) {
        return { kind: 'inconclusive', reason: `DATA: ${data.kind === 'reply' ? data.reply.code : data.kind}` };
      }
      // A 998-octet body line + CRLF = 1000 octets. Plus a minimal header.
      const body = cat(
        crlf`Subject: length test`,
        crlf``,
        rep(0x78, 998),
        CRLF,
        EOD,
      );
      await conn.send(body);
      const final = await conn.readReply(5000);
      if (final.kind !== 'reply') return { kind: 'inconclusive', reason: `1000-octet line drew ${final.kind}` };
      if (severity(final.reply) === 2) {
        return { kind: 'satisfied', detail: '1000-octet text line accepted' };
      }
      // A 4yz temporary failure (greylisting, filter busy) is NOT evidence the
      // line length was the problem — the server never rejected for length.
      if (severity(final.reply) === 4) {
        return { kind: 'inconclusive', reason: `temporary failure ${final.reply.code}, not a length rejection` };
      }
      // A 5yz is the length rejection = violation.
      return { kind: 'violated', detail: `1000-octet text line drew ${final.reply.code} (5yz) — rejected within the mandated length` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'command-line-512-accepted',
    defect: 'rejectCommandLineAt300',
    why: 'rejecting a command line within the 512-octet floor violates R-5321-4.5.3.1.4-a',
  },
  {
    catches: 'text-line-1000-accepted',
    defect: 'rejectTextLineAt500',
    why: 'rejecting a text line within the 1000-octet floor violates R-5321-4.5.3.1.6-a',
  },
];
