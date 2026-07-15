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
      'the server responds with an opening message." A server that stays silent on connect ' +
      'has not initiated a session. §3.1-e permits a 554 instead of 220, so any 2yz or 5yz ' +
      'greeting satisfies — only silence (or a non-reply) is the violation.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind === 'reply') {
        const sev = severity(g.reply);
        if (sev === 2 || sev === 5) {
          return { kind: 'satisfied', detail: `greeting ${g.reply.code} received` };
        }
        // A 4yz greeting is unusual but not clearly a §3.1-a violation (a message
        // WAS sent); record it as latitude-ish via satisfied-with-note rather
        // than a false conviction.
        return { kind: 'satisfied', detail: `greeting ${g.reply.code} received (unusual class)` };
      }
      if (g.kind === 'timeout') {
        return { kind: 'violated', detail: `no greeting within 5s of connecting (${g.kind})` };
      }
      return { kind: 'violated', detail: `connection ${g.kind} with no greeting` };
    },
  }),

  testCase({
    id: 'greeting-identifies-the-server',
    requirement: 'R-5321-4.1.1.1-d',
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
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'greeting-is-sent-on-connect',
    defect: 'silentOnConnect',
    why: 'sending no greeting on connect violates R-5321-3.1-a',
  },
  {
    catches: 'greeting-identifies-the-server',
    defect: 'greetingWithoutDomain',
    why: 'a greeting with no domain identification violates R-5321-4.1.1.1-d',
  },
];
