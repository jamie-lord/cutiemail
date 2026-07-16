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
import { crlf, cat, bare, CRLF } from '../wire/bytes.ts';
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

  testCase({
    id: 'vrfy-supported',
    requirement: 'R-5321-3.5.2-g',
    intent: 'the server supports VRFY (a SHOULD — declining it, e.g. 502, is conformant anti-harvesting)',
    rationale:
      '§3.5.2: "Server implementations SHOULD support both VRFY and EXPN." A SHOULD, and the ' +
      'reason it must be latitude not a MUST: a 502 "not implemented" for VRFY is standard ' +
      'anti-address-harvesting practice and entirely conformant. Supporting VRFY (a 250/251/252 ' +
      'that actually verifies or declines-to-verify-but-accepts) follows the SHOULD; a 502/500 ' +
      'is the permitted decline. We record which.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`VRFY postmaster`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'VRFY drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `VRFY: ${r.kind}` };
      // 502/500 "not implemented/recognized" = declined (permitted). A 25x — even
      // 252 "cannot VRFY but will accept" — means the command is supported.
      return r.reply.code === 502 || r.reply.code === 500
        ? { kind: 'violated', detail: `VRFY not supported (${r.reply.code}) — permitted anti-harvesting, §3.5.2-g is a SHOULD` }
        : { kind: 'satisfied', detail: `VRFY supported (${r.reply.code})` };
    },
  }),

  testCase({
    id: 'unknown-command-answered-500',
    requirement: 'R-5321-3.8-d',
    intent: 'an unrecognized command draws the SHOULD\'s 500 (vs another tolerant reply like 502)',
    rationale:
      '§3.8: "Servers are expected to be tolerant of unknown commands, issuing a 500 reply and ' +
      'awaiting further instructions." A SHOULD: the tolerance itself (not closing) is the §3.8-b/c ' +
      'MUST, tested elsewhere; what THIS records is the softer detail — whether the tolerant reply ' +
      'is specifically 500, or another non-close code like 502 "not implemented", which is a ' +
      'permitted decline. A server that CLOSES is a §3.8-c finding, out of scope here, so a ' +
      'close/timeout is inconclusive and left to that MUST test.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`WXYZ some argument`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'unknown command drew no reply within the timeout' };
      // A close is the §3.8-c MUST violation, judged by unknown-command-does-not-
      // close-connection — not this latitude case's business.
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `unknown command: ${r.kind} (a close is a §3.8-c matter, not §3.8-d latitude)` };
      // 500 follows the SHOULD; any other non-close reply (502, 501…) is the
      // permitted decline of the specific code.
      return r.reply.code === 500
        ? { kind: 'satisfied', detail: 'unknown command drew the SHOULD\'s 500' }
        : { kind: 'violated', detail: `unknown command drew ${r.reply.code}, not 500 (permitted — §3.8-d is a SHOULD; still tolerant)` };
    },
  }),

  testCase({
    id: 'help-supported',
    requirement: 'R-5321-4.1.1.8-e',
    intent: 'bare HELP draws a 211/214 (a SHOULD — declining it, e.g. 502/500, is conformant latitude)',
    rationale:
      '§4.1.1.8: "SMTP servers SHOULD support HELP without arguments." A SHOULD, and the register ' +
      'note is emphatic that a 502 (or 500) is permitted-latitude, not a failure — "a fair number ' +
      'of hardened MTAs disable HELP. Do not let the ease of the test tempt anyone into scoring ' +
      '502 as a defect." So a 211/214 follows the SHOULD; a 500/502 is the permitted decline. We ' +
      'record which. (This replaces a former MUST test that wrongly convicted a 500 to HELP.)',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`HELP`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'HELP drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `HELP: ${r.kind}` };
      // A 2yz (211 status / 214 help) supports HELP; anything else (500/502) is the
      // permitted decline. The outcome model maps a violated SHOULD to
      // permitted-latitude, so a decline never becomes a finding.
      return severity(r.reply) === 2
        ? { kind: 'satisfied', detail: `HELP supported (${r.reply.code})` }
        : { kind: 'violated', detail: `HELP not supported (${r.reply.code}) — permitted, §4.1.1.8-e is a SHOULD (many hardened MTAs disable HELP)` };
    },
  }),

  testCase({
    id: 'noop-ignores-parameter',
    requirement: 'R-5321-4.1.1.9-e',
    intent: 'NOOP with a parameter is ignored and still draws 250 (a SHOULD — a 501 for the arg is conformant latitude)',
    rationale:
      '§4.1.1.9: "If a parameter string is specified, servers SHOULD ignore it." A SHOULD, so a ' +
      'server that instead rejects NOOP-with-argument (501 "takes no arguments") is exercising ' +
      'permitted latitude, not violating anything — exactly parallel to RSET-with-args (§4.3.2-g). ' +
      'We record which way it goes.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`NOOP some-parameter`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'NOOP-with-arg drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `NOOP-with-arg: ${r.kind}` };
      // 250 follows the SHOULD (parameter ignored); a 501/500 is the permitted decline.
      return severity(r.reply) === 2
        ? { kind: 'satisfied', detail: `NOOP-with-parameter ignored, drew ${r.reply.code}` }
        : { kind: 'violated', detail: `NOOP-with-parameter drew ${r.reply.code}, not 250 (permitted — §4.1.1.9-e is a SHOULD to ignore it)` };
    },
  }),

  testCase({
    id: 'trailing-whitespace-tolerated',
    requirement: 'R-5321-4.1.1-a',
    intent: 'a command with trailing whitespace before the CRLF is tolerated (a SHOULD — rejecting it is conformant latitude)',
    rationale:
      '§4.1.1: "In the interest of improved interoperability, SMTP receivers SHOULD tolerate ' +
      'trailing whitespace before the terminating <CRLF>." A SHOULD, so a server that instead ' +
      'rejects "NOOP <SP><CRLF>" is exercising permitted latitude. We send a NOOP with one ' +
      'trailing space and record whether it is tolerated (2yz) or refused.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      // "NOOP " + CRLF — a bare command with one trailing space before the terminator.
      await conn.send(cat(bare`NOOP `, CRLF));
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'trailing-whitespace NOOP drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `trailing-whitespace NOOP: ${r.kind}` };
      // 2yz tolerates the trailing whitespace; anything else is the permitted decline.
      return severity(r.reply) === 2
        ? { kind: 'satisfied', detail: `trailing whitespace tolerated, drew ${r.reply.code}` }
        : { kind: 'violated', detail: `trailing whitespace refused with ${r.reply.code} (permitted — §4.1.1-a is a SHOULD to tolerate it)` };
    },
  }),

  testCase({
    id: 'reply-uses-space-when-no-text',
    requirement: 'R-5321-4.2.1-g',
    intent: 'a reply with no text still sends the <SP> after the code (a SHOULD — a bare code is permitted latitude)',
    rationale:
      '§4.2.1: "servers SHOULD send the <SP> if subsequent text is not sent." A SHOULD, and its ' +
      'flip side §4.2-o ("senders SHOULD NOT send bare codes") is likewise a SHOULD NOT — so a ' +
      'bare "250<CRLF>" with neither <SP> nor text is permitted latitude, not a violation (the ' +
      'reply-separator MUST tests deliberately do NOT convict it). We record whether the server ' +
      'always sends the <SP> or emits bare codes, reading the bare-code anomaly the reply reader ' +
      'already flags.',
    run: async (conn: Conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      if ((await conn.readReply(3000)).kind !== 'reply') return { kind: 'inconclusive', reason: 'no EHLO reply' };
      await conn.send(crlf`NOOP`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `NOOP: ${r.kind}` };
      // A bare-code anomaly (code with no separator/text) is the SHOULD decline;
      // a normal reply (code + <SP> + text) follows the SHOULD.
      const bare = r.reply.anomalies.some((a) => a.kind === 'bare-code');
      return bare
        ? { kind: 'violated', detail: 'server emits bare codes with no <SP> (permitted — §4.2.1-g/§4.2-o are SHOULD/SHOULD NOT)' }
        : { kind: 'satisfied', detail: `reply carries the <SP> separator (${r.reply.code})` };
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
  {
    case: 'vrfy-supported',
    follows: {}, // clean mutant answers VRFY 252 (supported)
    declines: { vrfyNotSupported: true }, // declines: 502 not implemented (anti-harvesting)
  },
  {
    case: 'unknown-command-answered-500',
    follows: {}, // clean mutant answers an unknown command with 500
    declines: { unknownCommand502: true }, // declines: tolerant but 502, not 500
  },
  {
    case: 'help-supported',
    follows: {}, // clean mutant answers HELP with 214
    declines: { rejectHelp: true }, // declines: 500 (HELP disabled) — permitted, a SHOULD
  },
  {
    case: 'noop-ignores-parameter',
    follows: {}, // clean mutant ignores the NOOP parameter and returns 250
    declines: { noop501OnArgs: true }, // declines: 501 for NOOP-with-argument
  },
  {
    case: 'trailing-whitespace-tolerated',
    follows: {}, // clean mutant's verb parser ignores trailing whitespace -> 250
    declines: { rejectTrailingWhitespace: true }, // declines: 500 on trailing whitespace
  },
  {
    case: 'reply-uses-space-when-no-text',
    follows: {}, // clean mutant sends "250 <text>" (SP present)
    declines: { bareCodeReplies: true }, // declines: bare "250" with no SP/text
  },
];
