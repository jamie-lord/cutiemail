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
];

export const CONTROLS: readonly LatitudeControl[] = [
  {
    case: '8bitmime-advertised',
    follows: {}, // clean mutant advertises 8BITMIME
    declines: { no8bitmime: true }, // conformant server that declines the SHOULD
  },
];
