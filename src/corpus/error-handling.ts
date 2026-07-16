/**
 * Error handling and robustness (RFC 5321 §4.1.1.10, §4.3.2).
 *
 * The obligations a server has when things go wrong: it must keep the connection
 * open through errors until QUIT, and it must speak well-formed reply codes even
 * when refusing. These are where a server's error paths — the least-exercised
 * code in most implementations — get tested.
 *
 * Note on SHOULD requirements in this area (§4.2.4-b "500 SHOULD be returned",
 * §4.3.2-g "SHOULD return 501 for args"): a declined SHOULD is permitted-latitude,
 * never a finding, so those cannot have a "catches a violation" negative control.
 * They belong in a latitude-observing module, not here; this module is MUST/MUST
 * NOT only, where a mutant can genuinely fail.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
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
    id: 'connection-stays-open-after-error',
    requirement: 'R-5321-4.1.1.10-b',
    intent: 'the server does not close the connection in response to an error, only to QUIT',
    rationale:
      '§4.1.1.10: "The receiver MUST NOT intentionally close the transmission channel until ' +
      'it receives and replies to a QUIT command (even if there was an error)." An ' +
      'unrecognised command is an error the server must answer and survive, not hang up on.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      // A syntactically-valid but unrecognised verb: an error the server must
      // reply to WITHOUT closing — UNLESS it is shutting down, in which case a
      // 421 then close is permitted (§3.8 / §4.2.1). So a close with no reply is
      // the violation; a 421-then-close is latitude.
      await conn.send(crlf`WATSUP now`);
      const r = await conn.readReply(3000);
      if (r.kind === 'closed' || r.kind === 'reset') {
        return { kind: 'violated', detail: `server ${r.kind} the connection on an unrecognised command with no reply at all` };
      }
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `unexpected: ${r.kind}` };
      // A 421 is the "service closing transmission channel" signal — the one
      // reply after which an immediate close is conformant.
      if (r.reply.code === 421) {
        return { kind: 'satisfied', detail: '421 (service shutting down) — close after this is permitted' };
      }
      // An ordinary error reply (500/502): the channel must stay open. Prove it
      // with a following NOOP.
      await conn.send(crlf`NOOP`);
      const n = await conn.readReply(3000);
      if (n.kind === 'reply' && n.reply.code === 421) {
        return { kind: 'satisfied', detail: '421 on the follow-up — shutdown is permitted' };
      }
      if (n.kind === 'closed' || n.kind === 'reset') {
        return { kind: 'violated', detail: `server closed after an ordinary error reply (${r.reply.code}), before QUIT and without a 421` };
      }
      return n.kind === 'reply'
        ? { kind: 'satisfied', detail: 'connection survived the error' }
        : { kind: 'inconclusive', reason: `NOOP after error: ${n.kind}` };
    },
  }),

  testCase({
    id: 'reply-codes-are-three-digits',
    requirement: 'R-5321-4.3.2-c',
    alsoTouches: ['R-5321-4.2-b', 'R-5321-4.2-s'],
    intent: 'the server transmits well-formed three-digit reply codes',
    rationale:
      '§4.3.2: "SMTP servers MUST NOT transmit reply codes ... that are other than three ' +
      'digits or that do not start in a digit between 2 and 5 inclusive." NOTE the narrow ' +
      'scope: this forbids a non-three-digit code or a bad FIRST digit ONLY. It does NOT ' +
      'constrain the second/third digit or the separator — those are §4.2 ABNF concerns with ' +
      'their own anomalies (code-out-of-grammar for the 2nd digit, malformed-separator), and ' +
      'convicting them here would over-reach. So we check only code-not-three-digits and a ' +
      'first digit outside 2-5.',
    run: async (conn): Promise<Judgement> => {
      const offenders: string[] = [];
      const check = (
        label: string,
        reply: { lines: readonly { codeBytes: Buffer }[]; anomalies: readonly { kind: string; detail: string }[] },
      ): void => {
        for (const a of reply.anomalies) {
          if (a.kind === 'code-not-three-digits') offenders.push(`${label}: ${a.detail}`);
        }
        // First digit outside 2-5 is the other §4.3.2-c prong. A multiline reply
        // repeats the code on EVERY line, so a bad first digit on any line — not
        // just the last — is a violation. The register note for §4.3.2-c says so
        // explicitly. Check every line's first code byte (0x32-0x35 = '2'-'5').
        for (const line of reply.lines) {
          const first = line.codeBytes[0];
          if (first !== undefined && (first < 0x32 || first > 0x35)) {
            offenders.push(`${label}: first code digit 0x${first.toString(16)} is outside 2-5`);
          }
        }
      };
      // Sample replies across several commands so a server that malforms only
      // some replies is still caught. The greeting, EHLO, and — importantly — a
      // MAIL reply, since different reply paths can differ.
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply') return { kind: 'inconclusive', reason: `greeting: ${g.kind}` };
      check('greeting', g.reply);

      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const e = await conn.readReply(3000);
      if (e.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO: ${e.kind}` };
      check('EHLO', e.reply);

      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const m = await conn.readReply(3000);
      if (m.kind === 'reply') check('MAIL', m.reply);

      await conn.send(crlf`RSET`);
      const rs = await conn.readReply(3000);
      if (rs.kind === 'reply') check('RSET', rs.reply);

      return offenders.length > 0
        ? { kind: 'violated', detail: offenders.join('; ') }
        : { kind: 'satisfied', detail: 'reply codes are well-formed three-digit codes' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'connection-stays-open-after-error',
    defect: 'closeWithout421',
    why: 'closing the connection on an error before QUIT violates R-5321-4.1.1.10-b',
  },
  {
    catches: 'reply-codes-are-three-digits',
    defect: 'fourDigitCode',
    why: 'a four-digit reply code violates R-5321-4.3.2-c',
    alsoProves: [
      {
        requirement: 'R-5321-4.2-b',
        why: 'a four-digit code is not "a three digit number", the exact §4.2 requirement — the same anomaly the test flags',
      },
    ],
  },
  {
    catches: 'reply-codes-are-three-digits',
    defect: 'twoDigitCode',
    why: 'a two-digit reply code violates R-5321-4.3.2-c',
    alsoProves: [
      {
        requirement: 'R-5321-4.2-b',
        why: 'a two-digit code is not "a three digit number" per §4.2',
      },
    ],
  },
  {
    // The other §4.3.2-c prong, and the whole of §4.2-s: a code that IS three
    // digits but whose first digit is outside 2-5. Without this the test's
    // first-digit check has no negative control and 4.2-s is only test-only.
    catches: 'reply-codes-are-three-digits',
    defect: 'firstDigitOutOfRange',
    why: 'a first digit outside 2-5 violates R-5321-4.3.2-c (second prong)',
    alsoProves: [
      {
        requirement: 'R-5321-4.2-s',
        why: '§4.2-s: "MUST NOT send reply codes whose first digits are other than 2, 3, 4, or 5" — this defect emits exactly such a code and the test catches it',
      },
    ],
  },
];
