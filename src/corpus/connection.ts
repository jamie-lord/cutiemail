/**
 * Connection initiation — the greeting (RFC 5321 §3.1, §4.1.1.1).
 *
 * The first bytes of every session. A server MUST send an opening message on
 * connect (§3.1-a) and MUST identify itself in that greeting (§4.1.1.1-d). These
 * are the cheapest possible checks — no command even needs to be sent — and a
 * failure here means the server is broken before a transaction can begin.
 *
 * Latitude to respect: §3.1-e permits a 554 in the greeting instead of 220 (the
 * server rejecting the whole session up front). So "a greeting arrived" is the
 * §3.1-a test, NOT "a 220 arrived" — failing a server for a conformant 554 would
 * be a false positive.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { severity } from '../wire/reply.ts';

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'greeting-is-sent-on-connect',
    requirement: 'R-5321-3.1-a',
    intent: 'the server sends an opening greeting when a client connects',
    rationale:
      '§3.1: "An SMTP session is initiated when a client opens a connection to a server and ' +
      'the server responds with an opening message." §3.1-e permits a 554 instead of 220, so ' +
      'any greeting satisfies. The violation we can OBSERVE is the server accepting the TCP ' +
      'connection then closing with no opening message. A timeout is NOT a violation: ' +
      '§4.5.3.2.1 anticipates a slow 220 ("servers accept a TCP connection but delay delivery ' +
      'of the 220 ... until their system load permits") and tells clients to wait 5 minutes — ' +
      'silent-forever is indistinguishable from slow within any practical budget, so a timeout ' +
      'is inconclusive.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind === 'reply') {
        // Any greeting — 220, a 554 session-reject (§3.1-e), even an unusual 4yz —
        // means the server responded with an opening message. §3.1-a is satisfied.
        return { kind: 'satisfied', detail: `greeting ${g.reply.code} received` };
      }
      if (g.kind === 'closed' || g.kind === 'reset') {
        return { kind: 'violated', detail: `server accepted the connection then ${g.kind} with no opening message` };
      }
      // timeout: the server may simply be slow (§4.5.3.2.1 permits a 5-minute wait).
      return {
        kind: 'inconclusive',
        reason: 'no greeting within the read budget; §4.5.3.2.1 permits a slow 220 (client waits up to 5 min)',
      };
    },
  }),

  testCase({
    id: 'greeting-identifies-the-server',
    requirement: 'R-5321-4.1.1.1-d',
    alsoTouches: ['R-5321-4.2-g'],
    intent: 'the greeting identifies the server (a domain/hostname after the code)',
    rationale:
      '§4.1.1.1: "The SMTP server identifies itself to the SMTP client in the connection ' +
      'greeting reply." The grammar makes the Domain mandatory in the greeting. A bare code ' +
      'with no identifying text does not identify the server.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply') return { kind: 'inconclusive', reason: `no greeting: ${g.kind}` };
      // The reply reader flags a bare code (no separator/text) and empty text.
      const missingIdentity = g.reply.anomalies.some(
        (a) => a.kind === 'bare-code' || a.kind === 'empty-text',
      );
      if (missingIdentity) {
        return { kind: 'violated', detail: 'greeting carries no identifying text (bare or empty)' };
      }
      // The first line's text should carry a hostname-ish token. Require at least
      // one non-space character in the text.
      const text = g.reply.lines[0]?.text.toString('latin1').trim() ?? '';
      // Strip an enhanced status code if present (it is not the identity).
      const identity = text.replace(/^\d+\.\d+\.\d+\s+/, '').trim();
      return identity.length > 0
        ? { kind: 'satisfied', detail: `greeting identifies: "${identity.split(/\s+/)[0]}"` }
        : { kind: 'violated', detail: 'greeting text present but carries no identifying token' };
    },
  }),

  testCase({
    id: 'ehlo-response-identifies-the-server',
    requirement: 'R-5321-4.1.1.1-d',
    // NOTE: this case checks ONLY the mandatory first-line Domain. It does not
    // (and cannot without knowing the server's full command set) check §4.1.1.1-l's
    // keyword-completeness duty, so that requirement is NOT listed here — see its
    // deliberatelyUncovered note in the register.
    intent: 'the EHLO response identifies the server on its first line',
    rationale:
      '§4.1.1.1: the server "identifies itself to the SMTP client in the connection greeting ' +
      'reply AND in the response to this command [EHLO]." The ehlo-ok-rsp grammar makes the ' +
      'Domain mandatory on the first line of the EHLO reply — distinct from the greeting, ' +
      'which is tested separately.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(Buffer.from('EHLO conformance-suite.invalid\r\n', 'latin1'));
      const e = await conn.readReply(3000);
      if (e.kind === 'timeout') return { kind: 'inconclusive', reason: 'EHLO drew no reply within the timeout (server may be slow)' };
      if (e.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO: ${e.kind}` };
      if (e.reply.code !== 250) return { kind: 'inconclusive', reason: `EHLO refused with ${e.reply.code}` };
      // The first line of the EHLO 250 reply must carry the server's domain.
      const first = e.reply.lines[0];
      const text = first?.text.toString('latin1').trim() ?? '';
      const identity = text.replace(/^\d+\.\d+\.\d+\s+/, '').split(/\s+/)[0] ?? '';
      return identity.length > 0
        ? { kind: 'satisfied', detail: `EHLO response identifies: "${identity}"` }
        : { kind: 'violated', detail: 'EHLO 250 reply first line carries no server identity' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'greeting-is-sent-on-connect',
    defect: 'closeOnConnect',
    why: 'accepting the connection then closing with no opening message violates R-5321-3.1-a',
  },
  {
    catches: 'greeting-identifies-the-server',
    defect: 'greetingWithoutDomain',
    why: 'a greeting with no domain identification violates R-5321-4.1.1.1-d',
    alsoProves: [
      {
        requirement: 'R-5321-4.2-g',
        why: '§4.2 Greeting ABNF: "220 " (Domain / address-literal) ... — a bare 220 with no Domain on the first line violates the greeting grammar, on the 220 code the production governs',
      },
    ],
  },
  {
    catches: 'ehlo-response-identifies-the-server',
    defect: 'ehloResponseNoDomain',
    why: 'an EHLO reply whose first line carries no domain violates R-5321-4.1.1.1-d',
  },
];
