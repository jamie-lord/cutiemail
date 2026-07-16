/**
 * Latitude observations — SHOULD/MAY behaviours the suite RECORDS rather than
 * convicts.
 *
 * These cases never produce a finding. A SHOULD that a server declines is
 * permitted-latitude, not a failure; the value is in the per-server matrix, which
 * then shows WHICH latitude each server takes — differential behavioural data a
 * developer building a server (or choosing one) actually wants. They exist partly
 * to exercise the four-state model's permitted-latitude path against real
 * exchanges, not just unit tests.
 *
 * Verified by verifyLatitudeControls (not verifyNegativeControls): a server that
 * FOLLOWS the SHOULD is conformant, and one that DECLINES it is
 * permitted-latitude — proving the suite does not red a conformant server for a
 * declined SHOULD, which is the whole reason the four-state model exists.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity, advertisedExtensions } from '../wire/reply.ts';
import type { LatitudeControl } from './latitude-control.ts';

export const CASES: readonly TestCase[] = [
  testCase({
    id: '8bitmime-advertised',
    requirement: 'R-5321-2.4-n',
    intent: 'the server advertises 8BITMIME (a SHOULD — declining is conformant latitude)',
    rationale:
      '§2.4: "8BITMIME SHOULD be supported by SMTP servers." A SHOULD, so a server that does ' +
      'not advertise it is exercising permitted latitude, NOT violating anything. We record ' +
      'which way the server goes; the outcome model grades a non-advertising server as ' +
      'permitted-latitude, never a finding.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const e = await conn.readReply(3000);
      if (e.kind !== 'reply' || e.reply.code !== 250) {
        return { kind: 'inconclusive', reason: `EHLO: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
      }
      // 'violated' for the SHOULD-behaviour-not-happening; the outcome model maps
      // a violated SHOULD to permitted-latitude, so this never produces a finding.
      return advertisedExtensions(e.reply).has('8BITMIME')
        ? { kind: 'satisfied', detail: '8BITMIME advertised' }
        : { kind: 'violated', detail: '8BITMIME not advertised (permitted — §2.4-n is a SHOULD)' };
    },
  }),

  testCase({
    id: 'rset-with-args-rejected-501',
    requirement: 'R-5321-4.3.2-g',
    intent: 'RSET carrying an argument draws a 501 (a SHOULD — ignoring the argument is conformant latitude)',
    rationale:
      '§4.3.2: "commands that are specified in this document as not accepting arguments (DATA, ' +
      'RSET, QUIT) SHOULD return a 501 message if arguments are supplied." A SHOULD, so a ' +
      'server that instead ignores the argument and returns 250 is exercising permitted ' +
      'latitude, not violating anything. We record which way it goes.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`RSET now`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'RSET-with-args drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RSET-with-args: ${r.kind}` };
      // 501 follows the SHOULD; a 250 (argument ignored) is the permitted decline.
      return r.reply.code === 501
        ? { kind: 'satisfied', detail: 'RSET-with-args drew 501' }
        : { kind: 'violated', detail: `RSET-with-args drew ${r.reply.code}, not 501 (permitted — §4.3.2-g is a SHOULD)` };
    },
  }),

  testCase({
    id: 'non-mail-command-without-greeting',
    requirement: 'R-5321-4.1.4-b',
    intent: 'VRFY (a non-mail command) is accepted without a prior EHLO (a SHOULD)',
    rationale:
      '§4.1.4: "An SMTP server SHOULD accept commands for non-mail transactions (e.g., VRFY ' +
      'or EXPN) without this initialization [EHLO]." A SHOULD, so a server that answers 503 ' +
      '"bad sequence" to a VRFY before EHLO is declining permitted latitude, not violating. ' +
      'We record it.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      // No EHLO — straight to VRFY.
      await conn.send(crlf`VRFY postmaster`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'VRFY drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `VRFY: ${r.kind}` };
      // A 503 "bad sequence" is the decline; anything else (252/250/502/550 — the
      // server processed the command rather than rejecting it for ordering) follows.
      return r.reply.code === 503
        ? { kind: 'violated', detail: 'VRFY before EHLO drew 503 bad-sequence (permitted — §4.1.4-b is a SHOULD)' }
        : { kind: 'satisfied', detail: `VRFY accepted without prior EHLO (${r.reply.code})` };
    },
  }),
];

export const CONTROLS: readonly LatitudeControl[] = [
  {
    case: '8bitmime-advertised',
    follows: {}, // clean mutant advertises 8BITMIME
    declines: { no8bitmime: true }, // conformant server that declines the SHOULD
  },
  {
    case: 'rset-with-args-rejected-501',
    follows: { rset501OnArgs: true }, // follows the SHOULD: 501 for RSET-with-args
    declines: {}, // clean mutant ignores the argument, returns 250 (permitted)
  },
  {
    case: 'non-mail-command-without-greeting',
    follows: {}, // clean mutant answers VRFY regardless of greeting state
    declines: { vrfy503BeforeGreeting: true }, // declines: 503 before EHLO
  },
];
