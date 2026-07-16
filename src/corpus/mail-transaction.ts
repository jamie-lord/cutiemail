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
    alsoTouches: ['R-5321-3.3-k'],
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
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'source-route-syntax-recognized',
    defect: 'rejectSourceRouteAsSyntax',
    why: 'returning a 501 syntax error for a source-route path violates R-5321-4.1.1.3-b',
  },
];
