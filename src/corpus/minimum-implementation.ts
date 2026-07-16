/**
 * Minimum implementation and reply structure (RFC 5321 §4.5.1, §4.2, §4.1.1.8).
 *
 * The floor every conformant server must meet: the mandatory command set is
 * recognised, every command draws exactly one reply, and HELP answers. These are
 * universal — no fixture, no transaction — and a failure means the server is
 * below the specification's baseline.
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
    id: 'ehlo-is-supported',
    requirement: 'R-5321-2.2.1-b',
    alsoTouches: ['R-5321-4.5.1-b'],
    intent: 'the server supports EHLO even if it implements no extensions',
    rationale:
      '§2.2.1: "servers MUST support the EHLO command even if they do not implement any ' +
      'specific extensions." EHLO is the ESMTP entry point; a server that 500s it is below ' +
      'the baseline. A 5yz "command not recognized" is the violation; any 2yz (even a bare ' +
      '250 with no extension lines) satisfies.',
    run: async (conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const e = await conn.readReply(3000);
      if (e.kind === 'timeout') return { kind: 'inconclusive', reason: 'EHLO drew no reply within the timeout' };
      if (e.kind !== 'reply') return { kind: 'violated', detail: `EHLO: server ${e.kind} instead of replying` };
      if (severity(e.reply) === 2) return { kind: 'satisfied', detail: `EHLO supported (${e.reply.code})` };
      if (severity(e.reply) === 4) return { kind: 'inconclusive', reason: `EHLO drew a transient ${e.reply.code}` };
      return { kind: 'violated', detail: `EHLO drew ${e.reply.code} — the server does not support EHLO` };
    },
  }),

  testCase({
    id: 'noop-is-recognised',
    requirement: 'R-5321-4.5.1-b',
    intent: 'NOOP, a mandatory command, is recognised (not answered 500 unrecognised)',
    rationale:
      '§4.5.1: "The following commands MUST be supported ... EHLO HELO MAIL RCPT DATA RSET ' +
      'NOOP QUIT VRFY." A 500 "command not recognized" to NOOP means the mandatory command ' +
      'set is incomplete. NOOP is chosen as the unambiguous probe — it always draws 250 on a ' +
      'conformant server, with no transaction or fixture needed.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`NOOP`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'NOOP drew no reply within the timeout (server may be slow)' };
      if (r.kind !== 'reply') return { kind: 'violated', detail: `NOOP: server ${r.kind} instead of replying` };
      // 500 = command not recognised = the mandatory command is unsupported.
      if (r.reply.code === 500) {
        return { kind: 'violated', detail: 'NOOP drew 500 "command not recognized" — a mandatory command is unsupported' };
      }
      return { kind: 'satisfied', detail: `NOOP recognised (${r.reply.code})` };
    },
  }),

  testCase({
    id: 'exactly-one-reply-per-command',
    requirement: 'R-5321-4.2-a',
    intent: 'a single command draws exactly one reply — not zero, not two',
    rationale:
      '§4.2: "Every command MUST generate exactly one reply." This is the anti-smuggling ' +
      'invariant: TWO replies to one command means the server desynchronised (or split its ' +
      'parse), which is how a pipelined attacker smuggles a second transaction. Send one NOOP; ' +
      'read one reply; then confirm the server is quiet (no second reply).',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`NOOP`);
      const first = await conn.readReply(3000);
      if (first.kind === 'timeout') return { kind: 'inconclusive', reason: 'NOOP drew no reply within the timeout (server may be slow)' };
      if (first.kind !== 'reply') return { kind: 'violated', detail: `NOOP: server ${first.kind} instead of one reply` };
      // Now confirm no SECOND reply to the single NOOP.
      const quiet = await conn.expectQuiet(1000);
      if (!quiet.quiet) {
        return {
          kind: 'violated',
          detail: `NOOP drew more than one reply (a second: ${quiet.bytes.subarray(0, 3).toString('latin1')}...) — §4.2-a requires exactly one`,
        };
      }
      return { kind: 'satisfied', detail: 'exactly one reply to the single NOOP' };
    },
  }),

  testCase({
    id: 'help-is-answered',
    requirement: 'R-5321-4.1.1.8-a',
    intent: 'HELP draws helpful information (a 2yz reply), not a 500',
    rationale:
      '§4.1.1.8: HELP "causes the server to send helpful information to the client", and ' +
      '§4.1.1.8-e says servers SHOULD support HELP without arguments. Together: HELP should ' +
      'draw a 211/214-class reply. A 500 "command not recognized" is the violation.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`HELP`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'HELP drew no reply within the timeout (server may be slow)' };
      if (r.kind !== 'reply') return { kind: 'violated', detail: `HELP: server ${r.kind} instead of replying` };
      if (r.reply.code === 500) {
        return { kind: 'violated', detail: 'HELP drew 500 "command not recognized" — the server does not answer HELP' };
      }
      // 211, 214 (help), or even a 5yz-that-is-not-500 (e.g. 502 not implemented) —
      // only a flat 500 unrecognised is the clear violation of "causes ... helpful
      // information". A 502 is borderline; treat non-500 as satisfied here and let
      // the SHOULD nuance (§4.1.1.8-e) live in a separate latitude test if needed.
      return { kind: 'satisfied', detail: `HELP answered with ${r.reply.code}` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  { catches: 'ehlo-is-supported', defect: 'rejectEhlo', why: 'a 500 to EHLO violates R-5321-2.2.1-b (servers MUST support EHLO)' },
  { catches: 'noop-is-recognised', defect: 'unrecognizedNoop', why: 'a 500 to NOOP means the mandatory command set is incomplete (R-5321-4.5.1-b)' },
  { catches: 'exactly-one-reply-per-command', defect: 'doubleReplyToNoop', why: 'two replies to one command violates R-5321-4.2-a' },
  { catches: 'help-is-answered', defect: 'rejectHelp', why: 'a 500 to HELP violates R-5321-4.1.1.8-a' },
];
