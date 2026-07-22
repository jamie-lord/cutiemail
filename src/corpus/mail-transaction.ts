/**
 * The mail transaction — MAIL, RCPT, and the syntax a receiver MUST parse.
 *
 * Most of §4.1.1.2/§4.1.1.3 is fixture-gated: whether a server accepts or
 * rejects a specific recipient depends on server-side state (is it a valid
 * mailbox? does the server relay for that domain?), which the RFC leaves to
 * policy. Those cases need operator-declared fixtures and are not in this module
 * yet. What IS unconditionally testable is command SYNTAX RECOGNITION — the
 * server must be able to PARSE constructs the grammar defines, independent of
 * whether it then accepts them.
 *
 * The source-route case below is the exemplar of a subtle MUST: "recognize" is
 * not "accept". A server may reject a source-routed recipient for any policy
 * reason (relaying, unknown user) with a 5yz — what it MUST NOT do is fail to
 * parse it and return a 501 syntax error. Getting this assertion wrong in either
 * direction is easy, and a test expecting 250 here would fail almost every server
 * on the Internet while citing a MUST.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

async function greetEhloMail(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply' || severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
  }
  await conn.send(crlf`EHLO conformance-suite.invalid`);
  const e = await conn.readReply(3000);
  if (e.kind !== 'reply' || e.reply.code !== 250) {
    return { kind: 'inconclusive', reason: `EHLO: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
  }
  await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
  const m = await conn.readReply(3000);
  if (m.kind !== 'reply' || severity(m.reply) !== 2) {
    return { kind: 'inconclusive', reason: `MAIL: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'source-route-syntax-recognized',
    requirement: 'R-5321-4.1.1.3-b',
    // R-5321-4.1.2-a ("the so-called source route ... MUST BE accepted") states the
    // same recognise-the-syntax duty from the grammar section: a 501 syntax error on
    // the source-routed path is exactly its violation too, which the primary's
    // rejectSourceRouteAsSyntax mutant demonstrates. It is wire-with-fixture (the
    // deeper "accept and route it" needs a fixture recipient), so this carrying it
    // makes it fixture-gated rather than a silent gap.
    alsoTouches: ['R-5321-3.3-k', 'R-5321-4.1.2-a'],
    intent: 'a source-routed recipient path is parsed, not rejected as a syntax error',
    rationale:
      '§4.1.1.3: "Receiving systems MUST recognize source route syntax." The assertion is ' +
      'NARROW — "recognize" is not "accept". A 501/500 SYNTAX rejection convicts; a 550/553/' +
      '554 policy rejection (see R-5321-4.1.1.3-k, which permits it explicitly) does NOT. A ' +
      'test expecting 250 here would fail almost every server on the Internet.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      // A source-routed path per §4.1.2 ABNF: @host,@host:mailbox. RFC 2606 names.
      await conn.send(crlf`RCPT TO:<@relay.example.org,@relay2.example.org:user@example.com>`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RCPT drew ${r.kind}` };
      // 501/500 = syntax error = the server failed to parse it = violation.
      // Anything else (250 accept, 550/551/553/554 policy reject) satisfies:
      // the server clearly parsed the construct before deciding on it.
      if (r.reply.code === 501 || r.reply.code === 500) {
        return {
          kind: 'violated',
          detail: `source-route path drew ${r.reply.code} (a syntax error — the server failed to recognize the syntax)`,
        };
      }
      return {
        kind: 'satisfied',
        detail: `source-route path recognized (drew ${r.reply.code}, not a syntax error)`,
      };
    },
  }),

  testCase({
    id: 'source-route-does-not-break-session',
    requirement: 'R-5321-3.3-k',
    intent: 'a source-routed forward-path leaves the server prepared: a well-formed reply of any class, and the session still usable',
    rationale:
      '§3.3: "Servers MUST be prepared to encounter a list of source routes in the forward-path." ' +
      'Per the register note, "be prepared" is NOT "must accept": 250, 550, 551 — and even a 501 ' +
      'policy/syntax refusal — are all conformant, and a 501 specifically is scored permitted-latitude ' +
      '(indistinguishable from a deliberate refusal). What the MUST forbids is being UNPREPARED: ' +
      'dropping the connection, resetting, or crashing on the construct. So this case does NOT judge ' +
      'the reply code at all — it judges that SOME well-formed reply came back AND a following RSET ' +
      'still works. A drop/reset convicts; a timeout is inconclusive (a slow server is not a broken ' +
      'one, §4.5.3.2). This is the §3.3-k half that source-route-syntax-recognized (§4.1.1.3-b) cannot ' +
      'reach, since that case judges the code and this one judges liveness.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RCPT TO:<@relay.example.org,@relay2.example.org:user@example.com>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'no reply to the source-routed RCPT within the timeout — slow, not provably unprepared (§4.5.3.2)' };
      }
      if (r.kind === 'closed' || r.kind === 'reset') {
        return { kind: 'violated', detail: `the server ${r.kind} the connection on a source-routed forward-path with no reply — the "unprepared" failure §3.3 forbids` };
      }
      // A well-formed reply of any class came back: the server PARSED and handled
      // the source route, which is exactly "prepared to encounter" it. Closing the
      // session AFTER a policy rejection (Exim `drop`, a tarpit) is not forbidden by
      // §3.3-k — the server was demonstrably prepared — so the RSET probe below is
      // corroboration for the note's "session usable" spirit and NEVER convicts.
      await conn.send(crlf`RSET`);
      const rs = await conn.readReply(3000);
      if (rs.kind === 'reply' && severity(rs.reply) === 2) {
        return { kind: 'satisfied', detail: `source route drew a well-formed ${r.reply.code} and the session stayed usable (RSET -> ${rs.reply.code})` };
      }
      return { kind: 'satisfied', detail: `source route drew a well-formed ${r.reply.code} — the server parsed and handled it (prepared); it then ${rs.kind === 'reply' ? `answered RSET ${rs.reply.code}` : rs.kind} (a post-rejection close is policy, not a §3.3-k failure)` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    // No alsoProves for R-5321-3.3-k: its register note (s3-3.ts) adjudicates a 501
    // to a source route as PERMITTED-LATITUDE (indistinguishable on the wire from a
    // deliberate policy refusal by a server that parsed it fine), not as evidence of
    // being "unprepared". So this 501-emitting defect does NOT demonstrate a 3.3-k
    // violation; it proves only the primary 4.1.1.3-b syntax-recognition duty.
    catches: 'source-route-syntax-recognized',
    defect: 'rejectSourceRouteAsSyntax',
    why: 'returning a 501 syntax error for a source-route path violates R-5321-4.1.1.3-b',
  },
  {
    catches: 'source-route-does-not-break-session',
    defect: 'dropOnSourceRoute',
    why: 'dropping the connection on a source-routed forward-path is the "unprepared" behaviour R-5321-3.3-k forbids',
  },
];
