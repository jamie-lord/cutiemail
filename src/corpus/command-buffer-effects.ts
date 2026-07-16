/**
 * Commands that must not affect transaction state (§4.1.1.5-9).
 *
 * RFC 5321 draws a bright line between the commands that BUILD a mail
 * transaction (MAIL, RCPT, DATA) and the ancillary commands that must leave it
 * untouched (VRFY, EXPN, HELP, NOOP) or deliberately tear it down (RSET). Four
 * of the sections here carry the same recurring sentence, verbatim — "This
 * command has no effect on the reverse-path buffer, the forward-path buffer, or
 * the mail data buffer" — once each for VRFY (§4.1.1.6), EXPN (§4.1.1.7), HELP
 * (§4.1.1.8) and NOOP (§4.1.1.9). The register counts them as four requirements
 * on purpose: a server that gets NOOP right and EXPN wrong is a real, common
 * shape, and collapsing them would let it look uniform.
 *
 * The observable is indirect, and that is the whole craft of this module. You
 * cannot see a buffer. You can only see the CONSEQUENCE of one being cleared:
 * build partial transaction state (EHLO, MAIL FROM), slip the command under test
 * in, then send RCPT. If the reverse-path buffer survived, RCPT is processed
 * normally; if the command wrongly cleared it, the sender is forgotten and RCPT
 * is out of sequence — 503. So a 503-after-the-command is the tell, and a normal
 * RCPT is the pass. We then complete the transaction (DATA) to prove it is still
 * usable end to end.
 *
 * Two traps the register flags and this module honours:
 *
 *   - VRFY/EXPN/HELP are OFTEN disabled (§3.5.1, §5, §7.3 all bless refusing
 *     them to defeat address harvesting). A 500/502 "not implemented" is
 *     conformant and tells us NOTHING about the buffers — so we gate on the
 *     command being recognised and yield `inconclusive` on a refusal, never a
 *     finding. Only a RECOGNISED command whose execution then cleared a buffer
 *     is the MUST NOT violation.
 *
 *   - For RSET (§4.1.1.5-a) the logic inverts: RSET MUST discard the sender, so
 *     the following RCPT MUST be REJECTED. But only 503 proves the SENDER was
 *     forgotten — a 550 (unknown recipient) would look like a rejection while
 *     actually proving the buffer SURVIVED. We distinguish 503 from every other
 *     reply, exactly as the register note on R-5321-4.1.1.5-a warns.
 *
 * §4.1.1.9-a is broader than the buffer sentence — "does not affect any
 * parameters or previously entered commands" — so it gets its own probe against
 * the greeting/EHLO state (the canonical "previously entered command"), rather
 * than re-testing the reverse-path buffer that §4.1.1.9-c already owns.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, cat, EOD } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

/**
 * Drive greeting -> EHLO -> MAIL FROM, leaving the reverse-path buffer populated.
 * Returns an inconclusive Judgement if any step failed (we cannot test what a
 * command does to a transaction we never managed to start), or null on success.
 */
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
    return { kind: 'inconclusive', reason: `MAIL FROM not accepted: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
  }
  return null;
}

/**
 * The shared buffer-survival probe for VRFY/EXPN/HELP/NOOP.
 *
 * Precondition: greeting, EHLO and MAIL FROM are done (reverse-path buffer is
 * populated). Sends `command`, then RCPT to the valid recipient, and judges:
 *
 *   - command refused as not-implemented (500/502/504) -> inconclusive. VRFY,
 *     EXPN and HELP MAY be disabled; a refusal is conformant and carries no
 *     information about the buffers. Gate, do not convict.
 *   - RCPT drew 503 (bad sequence)                     -> VIOLATED. The command
 *     cleared the reverse-path buffer, so the sender was forgotten.
 *   - RCPT accepted (2yz)                              -> the buffers survived;
 *     complete the transaction (DATA) for end-to-end evidence and pass.
 *   - anything else                                    -> inconclusive.
 */
async function bufferSurvivesAfter(conn: Conn, command: Buffer, label: string): Promise<Judgement> {
  const notReady = await greetEhloMail(conn);
  if (notReady !== null) return notReady;

  await conn.send(command);
  const c = await conn.readReply(3000);
  if (c.kind === 'timeout') {
    return { kind: 'inconclusive', reason: `${label} drew no reply within the timeout (server may be slow, §4.5.3.2)` };
  }
  if (c.kind !== 'reply') {
    return { kind: 'inconclusive', reason: `${label} drew ${c.kind}, not a reply — cannot attribute a buffer effect` };
  }
  // A not-implemented / not-recognised refusal is CONFORMANT (VRFY/EXPN/HELP may
  // be disabled per §3.5.1, §5, §7.3) and says nothing about the buffers — gate
  // to inconclusive rather than convict.
  if (c.reply.code === 500 || c.reply.code === 502 || c.reply.code === 504) {
    return {
      kind: 'inconclusive',
      reason: `${label} refused as not-implemented (${c.reply.code}); cannot test its effect on the buffers`,
    };
  }

  // The decisive probe. If the command cleared the reverse-path buffer, the
  // sender is gone and RCPT is out of sequence (503). If the buffer survived,
  // RCPT is processed normally for the valid recipient (2yz).
  await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
  const r = await conn.readReply(3000);
  if (r.kind === 'timeout') {
    return { kind: 'inconclusive', reason: `RCPT after ${label} drew no reply within the timeout (server may be slow, §4.5.3.2)` };
  }
  if (r.kind !== 'reply') {
    return { kind: 'inconclusive', reason: `RCPT after ${label} drew ${r.kind}, not a reply` };
  }
  if (r.reply.code === 503) {
    return {
      kind: 'violated',
      detail: `${label} cleared the reverse-path buffer: RCPT after it drew 503 (bad sequence), so MAIL FROM was forgotten`,
    };
  }
  if (severity(r.reply) !== 2) {
    return {
      kind: 'inconclusive',
      reason: `RCPT after ${label} drew ${r.reply.code} (neither 503 nor a 2yz acceptance); cannot attribute to a buffer effect`,
    };
  }

  // Reverse- and forward-path buffers survived. Complete the transaction to
  // prove it is still usable end to end. This is corroboration, never a gate —
  // the RCPT acceptance is already the proof, so a DATA hiccup must not demote
  // a genuine pass to inconclusive.
  await conn.send(crlf`DATA`);
  const d = await conn.readReply(3000);
  if (d.kind === 'reply' && d.reply.code === 354) {
    await conn.send(cat(crlf`Subject: buffer-survival probe`, crlf``, crlf`the transaction survived ${label}`, EOD));
    const final = await conn.readReply(5000);
    const finalDesc = final.kind === 'reply' ? String(final.reply.code) : final.kind;
    return {
      kind: 'satisfied',
      detail: `transaction survived ${label}: RCPT ${r.reply.code}, DATA 354, final ${finalDesc}`,
    };
  }
  return {
    kind: 'satisfied',
    detail: `${label} did not clear the buffers: RCPT accepted with ${r.reply.code}`,
  };
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'rset-discards-transaction-state',
    requirement: 'R-5321-4.1.1.5-a',
    intent: 'after RSET the stored sender is discarded, so a following RCPT is out of sequence (503)',
    rationale:
      '§4.1.1.5: "Any stored sender, recipients, and mail data MUST be discarded, and all ' +
      'buffers and state tables cleared." Observable via the reverse-path buffer: MAIL FROM, ' +
      'RSET, then RCPT. If the sender was discarded the RCPT is out of sequence and MUST draw ' +
      '503 — and ONLY 503 proves the sender was forgotten. A 550 (unknown recipient) would ' +
      'look like a rejection while actually proving the buffer SURVIVED, so 503 is ' +
      'distinguished from every other reply (register note on R-5321-4.1.1.5-a).',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const notReady = await greetEhloMail(conn);
      if (notReady !== null) return notReady;

      await conn.send(crlf`RSET`);
      const rset = await conn.readReply(3000);
      if (rset.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'RSET drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (rset.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `RSET drew ${rset.kind}, not a reply` };
      }
      if (severity(rset.reply) !== 2) {
        return { kind: 'inconclusive', reason: `RSET was refused with ${rset.reply.code}; cannot test the discard` };
      }

      // The reverse-path buffer MUST now be empty, so a bare RCPT is out of order.
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'RCPT after RSET drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (r.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `RCPT after RSET drew ${r.kind}, not a reply` };
      }
      if (r.reply.code === 503) {
        return { kind: 'satisfied', detail: 'RSET discarded the sender: RCPT after it drew 503 (bad sequence)' };
      }
      if (severity(r.reply) === 2) {
        return {
          kind: 'violated',
          detail: `RSET did NOT discard the sender: RCPT after it was accepted with ${r.reply.code}, so the reverse-path buffer survived`,
        };
      }
      return {
        kind: 'inconclusive',
        reason: `RCPT after RSET drew ${r.reply.code} (neither 503 nor a 2yz acceptance); cannot tell whether the sender was discarded`,
      };
    },
  }),

  testCase({
    id: 'ehlo-clears-the-transaction',
    requirement: 'R-5321-4.1.1.1-j',
    intent: 'a second EHLO mid-transaction clears the reverse-path buffer, so a following RCPT is out of sequence (503)',
    rationale:
      '§4.1.1.1: EHLO/HELO "and a \\"250 OK\\" reply to one of them, confirm that ... there is no ' +
      'transaction in progress and all state tables and buffers are cleared." So a 250 to EHLO is ' +
      'a PROMISE the transaction was reset — this is the EHLO-as-RSET behaviour, and the register ' +
      'note flags it as genuinely under-implemented. Observable exactly like RSET: MAIL FROM, then ' +
      'EHLO, then RCPT. Only a 503 (bad sequence) proves the sender was discarded; a 2yz acceptance ' +
      'means the buffer survived the EHLO — the false confirmation. TRAP (register note): assert on ' +
      'the RCPT, NOT the EHLO — a server is entitled to answer EHLO 250 mid-transaction; that IS ' +
      'the behaviour under test.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const notReady = await greetEhloMail(conn);
      if (notReady !== null) return notReady;

      // Re-issue EHLO mid-transaction; a 250 promises the reverse-path buffer is gone.
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const e = await conn.readReply(3000);
      if (e.kind === 'timeout') return { kind: 'inconclusive', reason: 'second EHLO drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      if (e.kind !== 'reply') return { kind: 'inconclusive', reason: `second EHLO drew ${e.kind}, not a reply` };
      if (e.reply.code !== 250) return { kind: 'inconclusive', reason: `second EHLO drew ${e.reply.code}, not 250 — no "buffers cleared" confirmation was made` };

      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'RCPT after the second EHLO drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RCPT after the second EHLO drew ${r.kind}, not a reply` };
      if (r.reply.code === 503) {
        return { kind: 'satisfied', detail: 'EHLO cleared the transaction: RCPT after it drew 503 (bad sequence), so the sender was discarded as the 250 confirmed' };
      }
      if (severity(r.reply) === 2) {
        return {
          kind: 'violated',
          detail: `EHLO returned 250 but did NOT clear the transaction: RCPT after it was accepted with ${r.reply.code}, so the reverse-path buffer survived — the confirmation was false`,
        };
      }
      return {
        kind: 'inconclusive',
        reason: `RCPT after the second EHLO drew ${r.reply.code} (neither 503 nor a 2yz acceptance); cannot tell whether the buffer was cleared`,
      };
    },
  }),

  testCase({
    id: 'vrfy-no-effect-on-buffers',
    requirement: 'R-5321-4.1.1.6-b',
    intent: 'VRFY between MAIL and RCPT leaves the reverse-path buffer intact',
    rationale:
      '§4.1.1.6: "This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer." Testable with no deliverability fixture beyond a ' +
      'valid recipient: MAIL FROM, VRFY, then RCPT. If VRFY cleared the reverse-path buffer ' +
      'the RCPT draws 503; if it survived the transaction proceeds. A VRFY refused as ' +
      'not-implemented (502) is conformant (§3.5.1) and yields inconclusive, not a finding.',
    needs: { fixture: ['validRecipient'] },
    run: (conn): Promise<Judgement> => bufferSurvivesAfter(conn, crlf`VRFY probe@example.com`, 'VRFY'),
  }),

  testCase({
    id: 'expn-no-effect-on-buffers',
    requirement: 'R-5321-4.1.1.7-c',
    intent: 'EXPN between MAIL and RCPT leaves the reverse-path buffer intact',
    rationale:
      '§4.1.1.7: "This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time." Same fixture-free ' +
      'probe as VRFY: MAIL FROM, EXPN, RCPT, assert not-503. EXPN is refused (502/500) by ' +
      'most MTAs as an anti-harvesting measure (§3.5.1, §7.3) — that is conformant and yields ' +
      'inconclusive; only a recognised EXPN that then cleared the buffer is the violation.',
    needs: { fixture: ['validRecipient'] },
    run: (conn): Promise<Judgement> => bufferSurvivesAfter(conn, crlf`EXPN list@example.com`, 'EXPN'),
  }),

  testCase({
    id: 'help-no-effect-on-buffers',
    requirement: 'R-5321-4.1.1.8-c',
    intent: 'HELP between MAIL and RCPT leaves the reverse-path buffer intact',
    rationale:
      '§4.1.1.8: "This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time." MAIL FROM, HELP, ' +
      'RCPT, assert not-503. A HELP refused with 502 (some hardened MTAs disable it) is ' +
      'conformant and yields inconclusive; a recognised HELP that cleared the buffer is the ' +
      'MUST NOT violation.',
    needs: { fixture: ['validRecipient'] },
    run: (conn): Promise<Judgement> => bufferSurvivesAfter(conn, crlf`HELP`, 'HELP'),
  }),

  testCase({
    id: 'noop-no-effect-on-buffers',
    requirement: 'R-5321-4.1.1.9-c',
    intent: 'NOOP between MAIL and RCPT leaves the reverse-path buffer intact',
    rationale:
      '§4.1.1.9: "This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time." MAIL FROM, NOOP, ' +
      'RCPT, assert not-503. NOOP is always recognised (it MUST draw 250, §4.1.1.9-b), so no ' +
      'not-implemented gate applies here — a 503 after NOOP is unambiguously a cleared buffer.',
    needs: { fixture: ['validRecipient'] },
    run: (conn): Promise<Judgement> => bufferSurvivesAfter(conn, crlf`NOOP`, 'NOOP'),
  }),

  testCase({
    id: 'noop-no-effect-on-previous-commands',
    requirement: 'R-5321-4.1.1.9-a',
    intent: 'NOOP does not discard previously entered commands: the EHLO/greeting state survives it',
    rationale:
      '§4.1.1.9: "This command does not affect any parameters or previously entered ' +
      'commands." Broader than the buffer sentence (R-5321-4.1.1.9-c) — it reaches the ' +
      'EHLO-negotiated session state too. Probed distinctly from the buffers: EHLO, NOOP, ' +
      'then MAIL FROM. If NOOP forgot the session had been greeted, the server behaves as if ' +
      'EHLO never happened and rejects MAIL with 503. (A server that accepts MAIL without a ' +
      'prior EHLO, §4.1.4-k, simply passes — the state having no observable effect is not a ' +
      'violation.)',
    run: async (conn): Promise<Judgement> => {
      const g = await conn.readReply(5000);
      if (g.kind !== 'reply' || severity(g.reply) !== 2) {
        return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
      }
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const e = await conn.readReply(3000);
      if (e.kind !== 'reply' || e.reply.code !== 250) {
        return { kind: 'inconclusive', reason: `EHLO: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
      }

      await conn.send(crlf`NOOP`);
      const n = await conn.readReply(3000);
      if (n.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'NOOP drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (n.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `NOOP drew ${n.kind}, not a reply` };
      }

      // If NOOP discarded the "previously entered" EHLO, the server now behaves
      // as ungreeted and rejects MAIL with 503.
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const m = await conn.readReply(3000);
      if (m.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'MAIL after NOOP drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (m.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `MAIL after NOOP drew ${m.kind}, not a reply` };
      }
      if (m.reply.code === 503) {
        return {
          kind: 'violated',
          detail: 'NOOP discarded a previously entered command: MAIL after EHLO+NOOP drew 503 (bad sequence), as if EHLO had never been issued',
        };
      }
      if (severity(m.reply) === 2) {
        return {
          kind: 'satisfied',
          detail: `NOOP left previously entered commands intact: MAIL after EHLO+NOOP accepted with ${m.reply.code}`,
        };
      }
      return { kind: 'inconclusive', reason: `MAIL after NOOP drew ${m.reply.code}; cannot attribute to a NOOP effect` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'rset-discards-transaction-state',
    defect: 'ignoreRset',
    why: 'a server that does not discard the sender on RSET violates R-5321-4.1.1.5-a',
  },
  {
    catches: 'ehlo-clears-the-transaction',
    defect: 'ehloKeepsTransaction',
    why: 'a 250 to EHLO while the reverse-path buffer survives is a false "buffers cleared" confirmation, violating R-5321-4.1.1.1-j',
  },
  {
    catches: 'vrfy-no-effect-on-buffers',
    defect: 'vrfyResetsState',
    why: 'a VRFY that clears the reverse-path buffer violates R-5321-4.1.1.6-b',
  },
  {
    catches: 'expn-no-effect-on-buffers',
    defect: 'expnResetsState',
    why: 'an EXPN that clears the reverse-path buffer violates R-5321-4.1.1.7-c',
  },
  {
    catches: 'help-no-effect-on-buffers',
    defect: 'helpResetsState',
    why: 'a HELP that clears the reverse-path buffer violates R-5321-4.1.1.8-c',
  },
  {
    catches: 'noop-no-effect-on-previous-commands',
    defect: 'noopResetsState',
    why: 'a NOOP that discards the EHLO/greeting state violates R-5321-4.1.1.9-a',
  },
  {
    catches: 'noop-no-effect-on-buffers',
    defect: 'noopResetsState',
    why: 'a NOOP that clears the reverse-path buffer violates R-5321-4.1.1.9-c',
  },
];
