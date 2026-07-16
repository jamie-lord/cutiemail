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

/**
 * Drive a full transaction (MAIL, RCPT, DATA, `body` + end-of-data) to the valid
 * recipient and return the end-of-data reply outcome. Assumes greeting+EHLO are
 * already done. Any setup failure surfaces as a non-'reply' outcome the caller
 * treats as inconclusive.
 */
async function sendMessage(conn: Conn, body: Buffer): Promise<import('../conformance/test-case.ts').ReplyOutcome> {
  await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
  const mail = await conn.readReply(3000);
  if (mail.kind !== 'reply' || severity(mail.reply) !== 2) return mail;
  await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
  const rcpt = await conn.readReply(3000);
  if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) return rcpt;
  await conn.send(crlf`DATA`);
  const data = await conn.readReply(3000);
  if (data.kind !== 'reply' || data.reply.code !== 354) return data;
  await conn.send(cat(body, EOD));
  return conn.readReply(5000);
}

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
    alsoTouches: ['R-5321-4.3.2-f'],
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

      // A line comfortably SHORTER than 512 (400 octets) must not be rejected as
      // "command too long" — that is R-5321-4.3.2-f, which forbids a too-long
      // rejection BELOW 512 (distinct from the at-floor 512 probe below, which is
      // 4.5.3.1.4-a). Probing here makes the exchange genuinely exercise the
      // sub-512 case, so the rejectCommandLineAt300 control legitimately proves it.
      await conn.send(cat(bare`NOOP `, rep(0x78, 400 - 5 - 2), CRLF));
      const mid = await conn.readReply(3000);
      if (mid.kind !== 'reply') return { kind: 'inconclusive', reason: `400-octet command drew ${mid.kind}` };
      if (mid.reply.code !== 250) {
        return {
          kind: 'violated',
          detail: `a 400-octet command line drew ${mid.reply.code} where an 8-octet-arg NOOP drew 250 — rejected as too long below the 512 floor (§4.3.2-f)`,
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

      // Isolate line-length from content/policy rejection. A 5yz at end-of-data is
      // the canonical site of CONTENT filtering (spam/AV/policy), which the RFC
      // permits (see the §4.5.2-d register note). So first run a control message
      // with a SHORT innocuous body line to the same recipient: if THAT is
      // rejected, the server rejects this transaction for reasons unrelated to
      // line length, and we cannot judge the length MUST — inconclusive. Only if
      // the short baseline is accepted AND the 1000-octet-line message is then
      // rejected is length the differentiator and the rejection a violation.
      const shortResult = await sendMessage(conn, cat(crlf`Subject: baseline`, crlf``, crlf`short body line`));
      if (shortResult.kind !== 'reply') return { kind: 'inconclusive', reason: `baseline transaction: ${shortResult.kind}` };
      if (severity(shortResult.reply) !== 2) {
        return {
          kind: 'inconclusive',
          reason: `a short-body control message was itself rejected (${shortResult.reply.code}) — the server rejects this transaction for reasons unrelated to line length`,
        };
      }

      // 998-octet body line + CRLF = 1000 octets. Same recipient, only the line
      // length differs from the accepted baseline.
      const longResult = await sendMessage(conn, cat(crlf`Subject: length test`, crlf``, rep(0x78, 998), CRLF));
      if (longResult.kind !== 'reply') return { kind: 'inconclusive', reason: `1000-octet line: ${longResult.kind}` };
      if (severity(longResult.reply) === 2) return { kind: 'satisfied', detail: '1000-octet text line accepted' };
      if (severity(longResult.reply) === 4) {
        return { kind: 'inconclusive', reason: `temporary failure ${longResult.reply.code}, not a length rejection` };
      }
      // Short accepted, long rejected 5yz: length is the only changed variable.
      return { kind: 'violated', detail: `a 1000-octet text line drew ${longResult.reply.code} (5yz) where a short body was accepted — rejected within the mandated length` };
    },
  }),

  testCase({
    id: 'local-part-64-accepted',
    requirement: 'R-5321-4.5.3.1.1-a',
    intent: 'a 64-octet local-part (the mandated floor) is accepted, not rejected for length',
    rationale:
      '§4.5.3.1.1: "The maximum total length of a user name or other local-part is 64 octets." A ' +
      'receiver MUST be able to accept a 64-octet local-part; rejecting one for LENGTH is the ' +
      'violation. The trap: a plain 550 "no such user" is conformant, so this needs a ' +
      'fixture-declared VALID 64-octet recipient, and isolates length by first confirming an ' +
      'ordinary (short) recipient is accepted — only then is a 5yz on the long-but-valid one a ' +
      'length rejection.',
    needs: { fixture: ['validRecipient', 'longLocalPartRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const m = await conn.readReply(3000);
      if (m.kind !== 'reply' || severity(m.reply) !== 2) return { kind: 'inconclusive', reason: `MAIL: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
      // Baseline: an ordinary (short) valid recipient must be accepted, so a later
      // rejection can be attributed to length, not to the server refusing recipients.
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const base = await conn.readReply(3000);
      if (base.kind !== 'reply' || severity(base.reply) !== 2) {
        return { kind: 'inconclusive', reason: `the ordinary baseline recipient was not accepted (${base.kind === 'reply' ? base.reply.code : base.kind}) — cannot isolate length` };
      }
      // The probe: the fixture-declared VALID 64-octet-local-part recipient.
      await conn.send(crlf`RCPT TO:<${conn.fixture.longLocalPartRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `64-octet-local-part RCPT drew ${r.kind}` };
      if (severity(r.reply) === 2) return { kind: 'satisfied', detail: '64-octet local-part accepted' };
      if (severity(r.reply) === 4) return { kind: 'inconclusive', reason: `64-octet-local-part RCPT drew a transient ${r.reply.code}` };
      return { kind: 'violated', detail: `a fixture-valid 64-octet local-part drew ${r.reply.code} where an ordinary recipient was accepted — rejected within the mandated 64-octet floor` };
    },
  }),

  testCase({
    id: 'long-domain-accepted',
    requirement: 'R-5321-4.5.3.1.2-a',
    intent: 'a domain near the 255-octet floor is accepted, not rejected for length',
    rationale:
      '§4.5.3.1.2: "The maximum total length of a domain name or number is 255 octets." A receiver ' +
      'MUST accept a domain up to this length; rejecting a long-but-valid domain for LENGTH is the ' +
      'violation. Same isolate-the-variable design as the local-part floor: a fixture-declared ' +
      'valid long-domain recipient, and an ordinary recipient accepted first so a 5yz on the long ' +
      'one is attributable to length.',
    needs: { fixture: ['validRecipient', 'longDomainRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const m = await conn.readReply(3000);
      if (m.kind !== 'reply' || severity(m.reply) !== 2) return { kind: 'inconclusive', reason: `MAIL: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const base = await conn.readReply(3000);
      if (base.kind !== 'reply' || severity(base.reply) !== 2) {
        return { kind: 'inconclusive', reason: `the ordinary baseline recipient was not accepted (${base.kind === 'reply' ? base.reply.code : base.kind}) — cannot isolate length` };
      }
      await conn.send(crlf`RCPT TO:<${conn.fixture.longDomainRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `long-domain RCPT drew ${r.kind}` };
      if (severity(r.reply) === 2) return { kind: 'satisfied', detail: 'long (near-255-octet) domain accepted' };
      if (severity(r.reply) === 4) return { kind: 'inconclusive', reason: `long-domain RCPT drew a transient ${r.reply.code}` };
      return { kind: 'violated', detail: `a fixture-valid ~245-octet domain drew ${r.reply.code} where an ordinary recipient was accepted — rejected within the mandated 255-octet floor` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'command-line-512-accepted',
    defect: 'rejectCommandLineAt300',
    why: 'rejecting a command line within the 512-octet floor violates R-5321-4.5.3.1.4-a',
    alsoProves: [
      {
        requirement: 'R-5321-4.3.2-f',
        why: '§4.3.2: "producing a \'command too long\' message for a command line shorter than 512 characters would violate ... 4.5.3.1.4" — the defect rejects the test\'s 400-octet probe (a sub-512 line), the exact forbidden act',
      },
    ],
  },
  {
    // The rejectCommandLineAt300 control above trips the test's earlier 400-octet
    // (§4.3.2-f) probe and returns before the at-floor 512 branch runs — so that
    // branch (the actual R-5321-4.5.3.1.4-a check) had no negative control. This
    // control passes everything <= 511 and rejects only AT 512, so the 400-octet
    // probe succeeds and the 512 branch is the thing proven to detect a violation.
    catches: 'command-line-512-accepted',
    defect: 'rejectCommandLineAt511',
    why: 'rejecting a command line AT the 512-octet floor violates R-5321-4.5.3.1.4-a — this control exercises the at-floor branch the 300-octet control skips',
  },
  {
    catches: 'text-line-1000-accepted',
    defect: 'rejectTextLineAt500',
    why: 'rejecting a text line within the 1000-octet floor violates R-5321-4.5.3.1.6-a',
  },
  {
    catches: 'local-part-64-accepted',
    defect: 'rejectLongLocalPart',
    why: 'rejecting a valid 64-octet local-part for length violates R-5321-4.5.3.1.1-a',
  },
  {
    catches: 'long-domain-accepted',
    defect: 'rejectLongDomain',
    why: 'rejecting a valid near-255-octet domain for length violates R-5321-4.5.3.1.2-a',
  },
];
