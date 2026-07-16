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
    alsoTouches: ['R-5321-4.5.1-b', 'R-5321-4.1.1.1-f'],
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
      if (e.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO drew ${e.kind}, not a reply — a mid-session close can be a rate-limiter or shutdown, not evidence EHLO is unsupported` };
      if (severity(e.reply) === 2) return { kind: 'satisfied', detail: `EHLO supported (${e.reply.code})` };
      if (severity(e.reply) === 4) return { kind: 'inconclusive', reason: `EHLO drew a transient ${e.reply.code}` };
      // Only "command not implemented/recognised" (500/502) denies EHLO SUPPORT.
      // Any other 5yz means EHLO was understood but refused for an unrelated
      // reason — notably a hardened server rejecting our `.invalid` EHLO name
      // (Postfix reject_unknown/invalid_helo_hostname -> 550) — which does NOT
      // mean the server lacks EHLO. Convicting it would false-positive a
      // conformant, EHLO-supporting server (same trap as helo-is-supported).
      if (e.reply.code === 500 || e.reply.code === 502) {
        return { kind: 'violated', detail: `EHLO drew ${e.reply.code} (command not implemented/recognised) — the server does not support EHLO` };
      }
      return { kind: 'inconclusive', reason: `EHLO drew ${e.reply.code}: understood but refused on policy (e.g. EHLO-hostname), not a command-support failure` };
    },
  }),

  testCase({
    id: 'noop-is-recognised',
    requirement: 'R-5321-4.5.1-b',
    alsoTouches: ['R-5321-4.3.2-e', 'R-5321-4.5.1-a'],
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
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `NOOP drew ${r.kind}, not a reply — a mid-session close can be a rate-limiter or shutdown, not evidence NOOP is unsupported` };
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
      if (first.kind !== 'reply') return { kind: 'inconclusive', reason: `NOOP drew ${first.kind}, not a reply — an incidental close (rate-limiter/shutdown) is not evidence of a reply-count violation; the §4.2-a concern is a SECOND reply, checked next` };
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

  // NOTE: HELP support is a SHOULD (§4.1.1.8-e), not a MUST — the register notes
  // for both §4.1.1.8-a and -e say a 500/502 to HELP is permitted-latitude (many
  // hardened MTAs disable HELP). What was a MUST test here wrongly convicted a
  // conformant HELP-disabled server on a 500; it now lives as a latitude profile
  // (`help-supported`) in latitude.ts, and §4.1.1.8-a is deliberately-uncovered.

  testCase({
    id: 'bare-postmaster-accepted',
    requirement: 'R-5321-2.3.5-g',
    intent: 'RCPT TO:<postmaster> — bare, no domain — is accepted',
    rationale:
      '§2.3.5: "The reserved mailbox name \\"postmaster\\" may be used in a RCPT command ' +
      'without domain qualification ... and MUST be accepted if so used." The one recipient the ' +
      'RFC guarantees without a fixture. The register note fixes the traps: open the transaction ' +
      'with MAIL FROM:<> (the null path §4.5.1 pairs with postmaster); assert the BARE form ' +
      '<postmaster> (postmaster@domain is a different requirement); do NOT follow through to DATA; ' +
      'and a 4yz is NOT a pass — on a greylisting server it is the expected first-contact answer, ' +
      'so it is inconclusive (retry), never a finding.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`MAIL FROM:<>`);
      const m = await conn.readReply(3000);
      if (m.kind !== 'reply' || severity(m.reply) !== 2) {
        return { kind: 'inconclusive', reason: `null-path MAIL FROM:<> not accepted (${m.kind === 'reply' ? m.reply.code : m.kind}) — cannot reach the RCPT probe` };
      }
      await conn.send(crlf`RCPT TO:<postmaster>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'bare postmaster RCPT drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `bare postmaster RCPT: ${r.kind}` };
      const sev = severity(r.reply);
      if (sev === 2) return { kind: 'satisfied', detail: `bare postmaster accepted (${r.reply.code})` };
      // A 4yz is a temporary deferral (greylisting) — the note's predicted first-
      // contact answer — not a refusal of the reserved mailbox.
      if (sev === 4) return { kind: 'inconclusive', reason: `bare postmaster deferred with ${r.reply.code} (temporary) — not a refusal, retry` };
      return { kind: 'violated', detail: `RCPT TO:<postmaster> (bare) drew ${r.reply.code} — the reserved mailbox MUST be accepted without domain qualification` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'ehlo-is-supported',
    defect: 'rejectEhlo',
    why: 'a 500 to EHLO violates R-5321-2.2.1-b (servers MUST support EHLO)',
    alsoProves: [
      {
        requirement: 'R-5321-4.1.1.1-f',
        why: '§4.1.1.1: not supporting SMTP service extensions "in violation of this specification" — read by the register as "a server MUST support EHLO"; a 500/502 refusal of the verb (this defect) is the exact violation',
      },
    ],
  },
  {
    catches: 'noop-is-recognised',
    defect: 'unrecognizedNoop',
    why: 'a 500 to NOOP means the mandatory command set is incomplete (R-5321-4.5.1-b)',
    alsoProves: [
      {
        requirement: 'R-5321-4.3.2-e',
        why: '§4.3.2: "producing a \'command not recognized\' error in response to the required subset of these commands is a violation" — NOOP is in that subset and this defect answers it with exactly that error',
      },
      {
        requirement: 'R-5321-4.5.1-a',
        why: 'a receiver that fails to recognise NOOP has not provided the "minimum implementation" §4.5.1 requires of all receivers',
      },
    ],
  },
  { catches: 'exactly-one-reply-per-command', defect: 'doubleReplyToNoop', why: 'two replies to one command violates R-5321-4.2-a' },
  { catches: 'bare-postmaster-accepted', defect: 'rejectBarePostmaster', why: 'rejecting the bare reserved mailbox <postmaster> violates R-5321-2.3.5-g' },
];
