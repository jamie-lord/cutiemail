/**
 * CRLF discipline and the SMTP-smuggling class.
 *
 * The flagship corpus module, and the reason a correctness-focused SMTP suite is
 * worth building. RFC 5321 is unambiguous that only <CRLF> terminates a line
 * (§2.3.8) and that a server MUST NOT accept lines ending only in <LF>
 * (§4.1.1.4). Implementations disagreed anyway, and that disagreement — an
 * inbound MTA and an outbound MTA parsing end-of-data differently — is exactly
 * SMTP smuggling (SEC Consult, Timo Longin, Dec 2023; CVE-2023-51764 and
 * relatives).
 *
 * The load-bearing subtlety, from the register notes on R-5321-2.3.8-a: the
 * finding lives in the DISAGREEMENT between two implementations, not in one
 * server's reading alone. So these tests classify what a server actually does
 * with a malformed terminator — honours it, rejects it, or the connection dies —
 * rather than asserting a single "correct" reply. A server that honours a bare
 * LF is non-conformant AND the dangerous half of a smuggling pair; a server that
 * rejects it is conformant. We report the behaviour, and the MUST NOT decides
 * severity.
 *
 * This module is the exemplar for src/corpus/AUTHORING.md. Match its rigour.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, lf, cat, b, EOD } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

/** Read the greeting, returning a Judgement only if it went wrong. */
async function greeting(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply') {
    return { kind: 'inconclusive', reason: `no greeting: ${g.kind}` };
  }
  if (severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting was ${g.reply.code}, not 2yz` };
  }
  return null;
}

/**
 * Drive EHLO/MAIL/RCPT/DATA to reach the 354 prompt. Returns an inconclusive
 * Judgement if any step failed (we cannot test end-of-data handling if we never
 * got into DATA), or null on success.
 */
async function reachData(conn: Conn): Promise<Judgement | null> {
  const bad = await greeting(conn);
  if (bad !== null) return bad;

  await conn.send(crlf`EHLO conformance-suite.invalid`);
  if ((await conn.readReply(3000)).kind !== 'reply') {
    return { kind: 'inconclusive', reason: 'no EHLO reply' };
  }
  await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
  const mail = await conn.readReply(3000);
  if (mail.kind !== 'reply' || severity(mail.reply) !== 2) {
    return { kind: 'inconclusive', reason: `MAIL not accepted: ${mail.kind === 'reply' ? mail.reply.code : mail.kind}` };
  }
  await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
  const rcpt = await conn.readReply(3000);
  if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) {
    return { kind: 'inconclusive', reason: `RCPT not accepted: ${rcpt.kind === 'reply' ? rcpt.reply.code : rcpt.kind}` };
  }
  await conn.send(crlf`DATA`);
  const data = await conn.readReply(3000);
  if (data.kind !== 'reply' || data.reply.code !== 354) {
    return { kind: 'inconclusive', reason: `DATA not accepted: ${data.kind === 'reply' ? data.reply.code : data.kind}` };
  }
  return null;
}

/**
 * Classify a server's response to a bare-LF-terminated command.
 *
 * This is the corrected heart of the bare-LF tests (a false positive the pressure
 * test caught). The forbidden act is EXECUTING the LF-terminated command, not
 * replying to it. So:
 *
 *   - silence               -> conformant (never recognised a complete line)
 *   - a 5yz/4yz error        -> conformant (rejected the bare LF — hardened server)
 *   - connection closed/RST  -> conformant (refused it)
 *   - a 2yz/3yz success      -> NON-conformant (the command was executed)
 *
 * The success case is the only violation, and it is precisely what the
 * honourBareLf mutant does (it replies 250 to the bare-LF EHLO).
 */
async function classifyBareLfResponse(conn: Conn, command: string): Promise<Judgement> {
  const r = await conn.readReply(1500);
  if (r.kind === 'timeout') {
    return { kind: 'satisfied', detail: `no action taken on the bare-LF ${command}` };
  }
  if (r.kind === 'closed' || r.kind === 'reset') {
    return { kind: 'satisfied', detail: `server refused the bare-LF ${command} (${r.kind})` };
  }
  const sev = severity(r.reply);
  if (sev === 2 || sev === 3) {
    return {
      kind: 'violated',
      detail: `server EXECUTED a bare-LF-terminated ${command} (replied ${r.reply.code}) — it recognized <LF> as a terminator`,
    };
  }
  // 4yz / 5yz: the server saw the bare LF and refused it. Conformant.
  return {
    kind: 'satisfied',
    detail: `server rejected the bare-LF ${command} with ${r.reply.code} (did not accept it)`,
  };
}

/**
 * Send a body whose fake end-of-data is `fakeEod`, then probe: a conformant
 * server keeps reading (silence), a vulnerable one replies mid-DATA. On silence
 * we close cleanly with the real EOD. `label` names the primitive for evidence.
 */
async function smuggleProbe(conn: Conn, fakeEod: Buffer, label: string): Promise<Judgement> {
  const payload = cat(
    crlf`Subject: smuggling probe`,
    crlf``,
    crlf`legitimate body line`,
    fakeEod,
    crlf`injected line after fake end-of-data`,
  );
  await conn.send(payload);

  const reacted = await conn.expectQuiet(1500);
  if (!reacted.quiet) {
    return {
      kind: 'violated',
      detail: `server treated ${label} as end-of-data (replied ${reacted.bytes.subarray(0, 3).toString('latin1')} inside DATA)`,
    };
  }
  await conn.send(EOD);
  const final = await conn.readReply(5000);
  return final.kind === 'reply'
    ? { kind: 'satisfied', detail: `${label} ignored; real end-of-data got ${final.reply.code}` }
    : { kind: 'inconclusive', reason: `no reply after real end-of-data: ${final.kind}` };
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'bare-lf-command-not-honoured',
    requirement: 'R-5321-2.3.8-a',
    alsoTouches: ['R-5321-4.1.1.4-i'],
    intent: 'a command line terminated by a bare LF (no CR) is not EXECUTED',
    rationale:
      '§2.3.8: conforming implementations MUST NOT recognize any other character ' +
      'sequence as a line terminator. The violation is EXECUTING a bare-LF-terminated ' +
      'command — not merely replying to it. A hardened server (e.g. Postfix with ' +
      'smtpd_forbid_bare_newline) that REJECTS the bare LF with an error, or drops the ' +
      'connection, has NOT recognized it as a terminator and is conformant — it is exactly ' +
      'the smuggling-safe server this suite exists to bless.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // EHLO terminated by a bare LF. A conformant server either stays silent
      // (never saw a complete line) or rejects it; only EXECUTING it (a success
      // reply to the EHLO) is the violation.
      await conn.send(lf`EHLO conformance-suite.invalid`);
      return classifyBareLfResponse(conn, 'EHLO');
    },
  }),

  testCase({
    id: 'bare-lf-line-acceptance-rejected',
    requirement: 'R-5321-4.1.1.4-i',
    intent: 'the server does not ACCEPT (execute) lines ending only in <LF>',
    rationale:
      '§4.1.1.4: "SMTP server systems MUST NOT do this, even in the name of improved ' +
      'robustness." The forbidden act is ACCEPTING the LF-terminated line, i.e. executing ' +
      'it as a command. Rejecting it with a 5yz error (the Postfix smtpd_forbid_bare_newline ' +
      'behaviour) or dropping the connection is a REFUSAL, not acceptance, and is conformant. ' +
      'A test that failed on any reply would fail exactly the anti-smuggling servers the ' +
      'suite is meant to certify.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // Proper EHLO first (establish a normal session), then a bare-LF command.
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO failed: ${ehlo.kind}` };

      await conn.send(lf`NOOP`);
      return classifyBareLfResponse(conn, 'NOOP');
    },
  }),

  testCase({
    id: 'lf-dot-lf-not-end-of-data',
    requirement: 'R-5321-4.1.1.4-j',
    alsoTouches: ['R-5321-4.1.1.4-i'],
    intent: 'the "<LF>.<LF>" sequence does not terminate mail data',
    rationale:
      '§4.1.1.4: "the sequence \\"<LF>.<LF>\\" (bare line feeds, without carriage ' +
      'returns) MUST NOT be treated as equivalent to <CRLF>.<CRLF>". This is the exact ' +
      'primitive SMTP smuggling uses to inject a second message. Needs a valid recipient ' +
      'to reach DATA.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const notReady = await reachData(conn);
      if (notReady !== null) return notReady;
      return smuggleProbe(conn, b(0x0a, 0x2e, 0x0a), '<LF>.<LF>');
    },
  }),

  testCase({
    id: 'lf-dot-crlf-not-end-of-data',
    requirement: 'R-5321-4.1.1.4-i',
    alsoTouches: ['R-5321-2.3.8-a'],
    intent: 'the "<LF>.<CR><LF>" sequence does not terminate mail data',
    rationale:
      'The highest-value smuggling primitive: Postfix (CVE-2023-51764), Sendmail ' +
      '(CVE-2023-51765) and Exim (CVE-2023-51766) all accepted <LF>.<CR><LF> as ' +
      'end-of-data in default configs, while GMX and Exchange Online passed it ' +
      'unfiltered outbound. The RFC only names <LF>.<LF> explicitly, but §4.1.1.4-i\'s ' +
      'general prohibition on LF-terminated lines covers this. See ' +
      'docs/research/smtp-divergence.md §1.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const notReady = await reachData(conn);
      if (notReady !== null) return notReady;
      return smuggleProbe(conn, b(0x0a, 0x2e, 0x0d, 0x0a), '<LF>.<CR><LF>');
    },
  }),

  testCase({
    id: 'cr-dot-cr-not-end-of-data',
    requirement: 'R-5321-4.1.1.4-i',
    alsoTouches: ['R-5321-2.3.8-a'],
    intent: 'the "<CR>.<CR>" sequence does not terminate mail data',
    rationale:
      'The Cisco Secure Email Gateway smuggling variant: its default "Clean" setting ' +
      'converts bare CR/LF to CRLF, turning <CR>.<CR> into <CRLF>.<CRLF> and ending ' +
      'DATA early (~40,000 domains vulnerable). Covered by §4.1.1.4-i. See ' +
      'docs/research/smtp-divergence.md §1.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const notReady = await reachData(conn);
      if (notReady !== null) return notReady;
      return smuggleProbe(conn, b(0x0d, 0x2e, 0x0d), '<CR>.<CR>');
    },
  }),

  testCase({
    id: 'unterminated-command-no-action',
    requirement: 'R-5321-2.4-f',
    intent: 'the server takes no action on a command line with no <CRLF>',
    rationale:
      '§2.4: "The receiver will take no action until this sequence is received." A ' +
      'server that replies to an unterminated line is acting on incomplete input — the ' +
      'same family of defect as honouring a bare LF, and a plausible smuggling primitive.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // A complete-looking command with NO terminator at all.
      await conn.send(Buffer.from('NOOP', 'latin1'));
      const quiet = await conn.expectQuiet(1500);
      return quiet.quiet
        ? { kind: 'satisfied', detail: 'no action taken on an unterminated command' }
        : { kind: 'violated', detail: 'server replied to a command that was never terminated by <CRLF>' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'bare-lf-command-not-honoured',
    defect: 'honourBareLf',
    why: 'honouring a bare LF as a command terminator violates §2.3.8 (R-5321-2.3.8-a)',
  },
  {
    catches: 'bare-lf-line-acceptance-rejected',
    defect: 'honourBareLf',
    why: 'accepting LF-terminated command lines is the §4.1.1.4-i custom the RFC forbids',
  },
  {
    catches: 'lf-dot-lf-not-end-of-data',
    defect: 'honourBareLfEndOfData',
    why: 'treating <LF>.<LF> as end-of-data is the SMTP-smuggling primitive (R-5321-4.1.1.4-j)',
  },
  {
    catches: 'lf-dot-crlf-not-end-of-data',
    defect: 'honourLfDotCrlfEndOfData',
    why: 'treating <LF>.<CR><LF> as end-of-data is CVE-2023-51764/65/66 (R-5321-4.1.1.4-i)',
  },
  {
    catches: 'cr-dot-cr-not-end-of-data',
    defect: 'honourCrDotCrEndOfData',
    why: 'treating <CR>.<CR> as end-of-data is the Cisco smuggling variant (R-5321-4.1.1.4-i)',
  },
  {
    catches: 'unterminated-command-no-action',
    defect: 'actOnUnterminatedLine',
    why: 'replying before <CRLF> arrives violates §2.4 (R-5321-2.4-f)',
  },
];
