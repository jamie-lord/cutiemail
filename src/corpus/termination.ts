/**
 * Connection termination (RFC 5321 §3.8).
 *
 * §3.8 is the most wire-testable prose in §3 — it is about WHEN a server is
 * allowed to hang up, and a socket dying is something we observe directly. Three
 * assigned obligations live here; only one survives as a standalone
 * negative-controllable case, and the two deliberate omissions are worth as much
 * as the one test.
 *
 * WHAT IS TESTED
 *
 *   R-5321-3.8-c (MUST NOT): "a server that closes connections in response to
 *   commands that are not understood is in violation of this specification." Send
 *   a garbage verb on an otherwise well-behaved, low-rate session and assert the
 *   channel survives — the server must REPLY (500/502), not hang up. This is the
 *   one clause in §3.8 that the register (see the note on R-5321-3.8-c) calls the
 *   case "we can actually test cleanly": here "intentionally" is not a defence,
 *   because the RFC has pre-judged the intent of a close-on-unknown-command.
 *
 * WHAT IS DELIBERATELY NOT TESTED, AND WHY
 *
 *   R-5321-3.8-a (MUST — QUIT: positive reply then close) is ALREADY covered by
 *   session-sequencing.ts `quit-returns-221-and-closes`, which reads the 221 and
 *   observes the ordered close via the `quitWrongReply` / `quitResetsAfterReply`
 *   mutants. The register note on R-5321-3.8-a is explicit that a standalone
 *   §3.8-a test may assert only 2yz-then-close (§4.1.1.10 / R-5321-3.8-b carry
 *   the specific 221), and that a 2yz-asserting test would be caught by the very
 *   same `quitWrongReply` mutant — "otherwise the same defect gets counted
 *   twice." So a §3.8-a case here would be a double-count the register warns
 *   against, not new coverage. Omitted on purpose; no contrived `alsoTouches`.
 *
 *   R-5321-3.8-d (SHOULD — tolerate unknown commands, issue 500) is a SHOULD. A
 *   declined SHOULD grades to `permitted-latitude`, never `non-conformant`, so no
 *   mutant can make a §3.8-d test the finding the negative-control harness
 *   requires — the same reason error-handling.ts keeps its SHOULDs out. It is not
 *   dropped, though: the §3.8-c exchange also bears on it (the reply that arrives,
 *   and the follow-up NOOP that proves the server is "awaiting further
 *   instructions"), so §3.8-d rides along as `alsoTouches`.
 *
 * RELATIONSHIP TO error-handling.ts
 *
 *   `connection-stays-open-after-error` (R-5321-4.1.1.10-b) is the SAME observable
 *   behaviour — an unknown command must not sever the channel — seen from the
 *   general clause. This case exists because §3.8-c is a distinct register line
 *   item, registered separately precisely because it is the cleanly testable
 *   specialisation; the coverage report should show it covered on its own terms.
 *   It reuses the same `closeWithout421` mutant, which is correct: one defect (a
 *   bare close on an unintelligible command) violates both clauses at once.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

/** Read the greeting and send EHLO. Returns a Judgement only if the open failed. */
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
    id: 'unknown-command-does-not-close-connection',
    requirement: 'R-5321-3.8-c',
    alsoTouches: ['R-5321-3.8-d'],
    intent: 'a syntactically-shaped but unrecognised command draws a reply and does not sever the channel',
    rationale:
      '§3.8: "In particular, a server that closes connections in response to commands that ' +
      'are not understood is in violation of this specification." The forbidden act is the ' +
      'CLOSE (§3.8-d, a SHOULD, carries the reply-code question separately — this case does ' +
      'NOT assert 500 vs 502). Two escape hatches keep the assertion honest: (1) a timeout is ' +
      'a slow server, not a violation (§4.5.3.2 permits minutes) — inconclusive, never ' +
      'convicted; (2) a 421 "service closing" reply is the §3.8-b shutdown exception, after ' +
      'which an immediate close is conformant. Only a bare close (no reply line at all), or a ' +
      'close after an ordinary error reply before QUIT and without a 421, is the violation. ' +
      'We probe with the register\'s own suggested garbage verb (XYZZY) on an idle, low-rate ' +
      'session so §7.8 abuse-dropping cannot be the excuse, then confirm the channel is still ' +
      'usable with a following NOOP — the "awaiting further instructions" half of §3.8-d.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;

      // A syntactically well-formed but wholly unrecognised verb: the exact
      // "command that is not understood" §3.8-c names. Not a malformed known
      // command (that is §4.1.1 / 4.1.1.10-b territory) — a genuine unknown verb,
      // so "intentionally" is no defence and the RFC has pre-judged the intent.
      await conn.send(crlf`XYZZY frobnicate the widget`);
      const r = await conn.readReply(3000);

      // A slow reply is not a missing one: §4.5.3.2 permits generous minimums, so
      // a timeout is inconclusive, never a conviction. Only closed/reset convict.
      if (r.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'the unknown command drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      // The §3.8-c violation in its purest form: the server hung up on an
      // unintelligible command without answering at all.
      if (r.kind === 'closed' || r.kind === 'reset') {
        return { kind: 'violated', detail: `server ${r.kind} the connection in response to an unrecognised command, with no reply at all` };
      }
      // Only 'reply' remains (ReplyOutcome is reply|timeout|closed|reset).

      // A 421 is the "service closing transmission channel" signal — the one reply
      // (§3.8-b) after which an immediate close is conformant. A shutting-down
      // server is out of scope of §3.8-c, so this is a pass, not a violation.
      if (r.reply.code === 421) {
        return { kind: 'satisfied', detail: '421 (service shutting down) — a close after this is permitted (§3.8-b)' };
      }

      // An ordinary error reply (typically 500/502): the channel MUST stay open
      // until QUIT. Prove it is still alive and usable with a NOOP.
      await conn.send(crlf`NOOP`);
      const n = await conn.readReply(3000);
      if (n.kind === 'reply' && n.reply.code === 421) {
        return { kind: 'satisfied', detail: '421 on the follow-up NOOP — shutdown is permitted (§3.8-b)' };
      }
      if (n.kind === 'closed' || n.kind === 'reset') {
        return { kind: 'violated', detail: `server closed after replying ${r.reply.code} to an unrecognised command, before QUIT and without a 421` };
      }
      if (n.kind === 'timeout') {
        return { kind: 'inconclusive', reason: `unknown command drew ${r.reply.code}; the follow-up NOOP drew no reply within the timeout (server slow but still connected)` };
      }
      return { kind: 'satisfied', detail: `unknown command drew ${r.reply.code} and the channel survived (NOOP answered)` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'unknown-command-does-not-close-connection',
    defect: 'closeWithout421',
    why:
      'dropping the connection on a command it does not understand, with no reply and no 421, ' +
      'is the exact behaviour §3.8 declares "in violation of this specification" (R-5321-3.8-c)',
  },
];
