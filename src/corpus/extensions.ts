/**
 * ESMTP extension conformance — conditional on advertisement.
 *
 * The governing rule (R-5321-4.2.4-c) is that a server MUST NOT advertise a
 * capability it will then refuse. So extension tests are CONDITIONAL: a server
 * not advertising an extension is out of scope for it (inconclusive), never
 * non-conformant. This is the design principle for the whole module — declare
 * the extension in `needs.ehlo` and the runner gates on it.
 *
 * Full STARTTLS command-injection testing (the NO STARTTLS / CVE-2011-0411
 * class — send `STARTTLS\r\nNOOP\r\n` in one segment and prove the injected
 * command is not processed inside TLS) requires completing a TLS handshake,
 * which the mutant server does not yet implement. That case is deferred and
 * tracked; docs/research/smtp-divergence.md §3 has the exact primitive. What is
 * testable now without TLS is the advertise-vs-honour contract: an advertised
 * STARTTLS must not be refused.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

async function greeting(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply' || severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'helo-is-supported',
    requirement: 'R-5321-4.1.1.1-h',
    intent: 'the server supports HELO and replies with a 2yz',
    rationale:
      '§4.1.1.1: "servers MUST support the HELO command and reply properly to it." HELO is ' +
      'the mandatory fallback for clients that do not speak ESMTP; a server refusing it is ' +
      'non-conformant.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`HELO conformance-suite.invalid`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'violated', detail: `HELO drew ${r.kind}` };
      return severity(r.reply) === 2
        ? { kind: 'satisfied', detail: `HELO accepted with ${r.reply.code}` }
        : { kind: 'violated', detail: `HELO drew ${r.reply.code}, not a 2yz — server does not support HELO` };
    },
  }),

  testCase({
    id: 'advertised-starttls-is-honoured',
    requirement: 'R-5321-4.2.4-c',
    intent: 'a server advertising STARTTLS does not then refuse the STARTTLS command',
    rationale:
      '§4.2.4: "Extended SMTP systems MUST NOT list capabilities in response to EHLO for ' +
      'which they will return 502 (or 500) replies." If EHLO advertises STARTTLS, the ' +
      'STARTTLS command MUST NOT draw a 502/500. Conditional on STARTTLS being advertised.',
    needs: { ehlo: ['STARTTLS'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO: ${ehlo.kind}` };
      // The runner's ehlo-gate guarantees STARTTLS is advertised, but the runner
      // re-opens the connection after gating, so we re-EHLO here and proceed.
      await conn.send(crlf`STARTTLS`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `STARTTLS drew ${r.kind}` };
      // 502/500 = "advertised but not implemented" = the violation. A 220 (ready)
      // is the honoured case. (We do not complete the handshake here.)
      if (r.reply.code === 502 || r.reply.code === 500) {
        return {
          kind: 'violated',
          detail: `EHLO advertised STARTTLS but the command drew ${r.reply.code}`,
        };
      }
      return { kind: 'satisfied', detail: `advertised STARTTLS honoured (${r.reply.code})` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'helo-is-supported',
    defect: 'rejectHelo',
    why: 'refusing HELO violates R-5321-4.1.1.1-h (servers MUST support HELO)',
  },
  {
    catches: 'advertised-starttls-is-honoured',
    defect: 'advertiseStarttlsButReject',
    why: 'advertising STARTTLS then 502-ing it violates R-5321-4.2.4-c',
  },
];
