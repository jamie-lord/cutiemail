/**
 * Command case-insensitivity and invalid characters.
 *
 * Two unrelated-looking rules that share a root: RFC 5321 fixes the LEXICAL shape
 * of a command line — which bytes are a verb, which case they may be in, which
 * octets are legal at all — and a receiver is not free to be creative about it.
 *
 *   - §2.4: "Verbs and argument values ... are not case sensitive". A server that
 *     demands upper-case verbs is named a violator in the very next breath ("A few
 *     SMTP servers, in violation of this specification (and RFC 821) require that
 *     command verbs be encoded by clients in upper case"). This was a real
 *     historical divergence, which is why our own client (R-5321-2.4-e note)
 *     deliberately does NOT paper over it by sending upper-case.
 *
 *   - §4.1.2: ASCII control characters (0-31 and 127) and high-bit octets "MUST
 *     NOT be used in MAIL or RCPT commands" (R-5321-4.1.2-j), and a receiver that
 *     gets one "and for which there are no other reasons for rejection, MUST
 *     reject that command with a 501 response" (R-5321-4.1.2-n). A control octet in
 *     an envelope command is also a classic injection/smuggling primitive, so a
 *     server that SWALLOWS one is interesting regardless of the code it returns.
 *
 * Two lenses on the same control-char probe, kept as separate cases on purpose:
 * the §4.1.2-j lens is the anti-smuggling one — any rejection blesses the server,
 * only EXECUTION convicts (mirroring classifyBareLfResponse in crlf-discipline);
 * the §4.1.2-n lens is the receiver's SPECIFIC duty — the register note is
 * emphatic that here, uniquely, the code is EXACT (501), not a class, so a 500 or
 * a 550 is a genuine miss, not latitude. A server can satisfy -j (rejects with
 * 550) while violating -n (not 501); they are different requirements, not one.
 *
 * The load-bearing choice of octet: a C0 CONTROL character (NUL, BEL), never a
 * high-bit octet. §4.1.2-n's parenthetical latitude ("could be overridden by
 * appropriate SMTP extensions") and §2.4's 8BITMIME/SMTPUTF8 carve-outs lift the
 * NON-ASCII (high-bit) restriction once negotiated — but nothing in 5321 or 6531
 * ever makes a raw NUL legal in an envelope command. Probing with a control octet
 * sidesteps the SMTPUTF8 trap entirely: the answer does not depend on what the
 * server advertised, so no `needs.ehlo` guard is required.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
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
 * Read the greeting and send an upper-case EHLO, returning the EHLO reply only if
 * it succeeded (250). The control-char cases need a greeted session before MAIL,
 * because a conformant server answers a premature MAIL with 503 (an "other reason
 * for rejection") which would mask the character-code question entirely.
 *
 * Note this EHLO is UPPER-CASE — the case-insensitivity case is the one place we
 * deliberately vary it; everywhere else we speak the canonical form so the only
 * thing under test is the thing named in the requirement.
 */
async function greetAndEhlo(conn: Conn): Promise<Judgement | null> {
  const bad = await greeting(conn);
  if (bad !== null) return bad;
  await conn.send(crlf`EHLO conformance-suite.invalid`);
  const e = await conn.readReply(3000);
  if (e.kind !== 'reply' || e.reply.code !== 250) {
    return { kind: 'inconclusive', reason: `EHLO not accepted: ${e.kind === 'reply' ? e.reply.code : e.kind}` };
  }
  return null;
}

/**
 * Classify a server's response to a MAIL command carrying a C0 control octet,
 * through the §4.1.2-j (MUST NOT be USED) lens. Modelled exactly on
 * classifyBareLfResponse: the forbidden act is EXECUTING the command, not merely
 * replying to it.
 *
 *   - a 2yz/3yz success -> NON-conformant (the server accepted/executed a command
 *     with a forbidden octet — it "used" the control character)
 *   - a 4yz/5yz error   -> conformant (it refused the command; the octet was not used)
 *   - connection dropped -> conformant (refused, a harder refusal)
 *   - timeout            -> inconclusive (the line was CRLF-terminated, so the
 *     server WILL frame it; a missing reply is a slow server, §4.5.3.2, never a
 *     conviction — the bare-LF case can treat silence as a pass because there the
 *     line was never completed, but here it was)
 */
async function classifyControlCharUse(conn: Conn): Promise<Judgement> {
  const r = await conn.readReply(3000);
  if (r.kind === 'timeout') {
    return { kind: 'inconclusive', reason: 'MAIL with a control octet drew no reply within the timeout (server may be slow, §4.5.3.2)' };
  }
  if (r.kind === 'closed' || r.kind === 'reset') {
    return { kind: 'satisfied', detail: `server refused the control-octet MAIL (${r.kind}) — it did not execute it` };
  }
  const sev = severity(r.reply);
  if (sev === 2 || sev === 3) {
    return {
      kind: 'violated',
      detail: `server ACCEPTED a MAIL command containing a control octet (replied ${r.reply.code}) — §4.1.2-j forbids using control characters in MAIL/RCPT commands`,
    };
  }
  return { kind: 'satisfied', detail: `server rejected the control-octet MAIL with ${r.reply.code} (did not use it)` };
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'command-verb-case-insensitive',
    requirement: 'R-5321-2.4-a',
    intent: 'a lower-case command verb ("ehlo") is treated exactly as its upper-case form',
    rationale:
      '§2.4: "Verbs and argument values (e.g., \\"TO:\\" or \\"to:\\" in the RCPT command ' +
      'and extension name keywords) are not case sensitive". The section then names the ' +
      'contrary behaviour a violation outright: "A few SMTP servers, in violation of this ' +
      'specification (and RFC 821) require that command verbs be encoded by clients in upper ' +
      'case." Read as a server MUST accept a verb in any case. We first confirm the server ' +
      'answers an UPPER-case EHLO with 250 (else it may not speak ESMTP at all, which is out ' +
      'of scope here), then re-issue the identical command lower-cased and require the same ' +
      '250. A 5yz to the lower-case verb is the divergence the requirement forbids.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;

      // Baseline: does the server accept an ordinary UPPER-case EHLO? If not, it
      // may not support EHLO at all — out of scope for a case-folding test, so
      // inconclusive rather than a false conviction.
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const upper = await conn.readReply(3000);
      if (upper.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `upper-case EHLO drew ${upper.kind}` };
      }
      if (upper.reply.code !== 250) {
        return { kind: 'inconclusive', reason: `upper-case EHLO drew ${upper.reply.code}, not 250 (server may not support EHLO)` };
      }

      // The probe: the SAME command, verb lower-cased. Re-issuing EHLO mid-session
      // is legal (§4.1.4 — a client MAY issue EHLO later in the session; it resets
      // state like RSET), so a conformant server simply answers 250 again.
      await conn.send(crlf`ehlo conformance-suite.invalid`);
      const lower = await conn.readReply(3000);
      if (lower.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'lower-case ehlo drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (lower.kind !== 'reply') {
        return { kind: 'inconclusive', reason: `lower-case ehlo drew ${lower.kind}, not a reply` };
      }
      if (lower.reply.code === 250) {
        return { kind: 'satisfied', detail: 'lower-case ehlo drew 250, identical to upper-case EHLO' };
      }
      if (severity(lower.reply) === 5) {
        return {
          kind: 'violated',
          detail: `server rejected the lower-case verb "ehlo" with ${lower.reply.code} while accepting "EHLO" with 250 — command verbs are not case sensitive (§2.4)`,
        };
      }
      // A 4yz (or other) to a valid, well-formed command we cannot pin on case.
      return { kind: 'inconclusive', reason: `lower-case ehlo drew ${lower.reply.code}; not attributable to case sensitivity` };
    },
  }),

  testCase({
    id: 'control-char-in-mail-not-executed',
    requirement: 'R-5321-4.1.2-j',
    alsoTouches: ['R-5321-2.4-a'],
    intent: 'a MAIL command carrying an ASCII control octet (NUL) is not accepted/executed',
    rationale:
      '§4.1.2: control characters ("decimal value 0-31 and 127") "MUST NOT be used in MAIL or ' +
      'RCPT commands or other commands that require mailbox names." The wire-observable half ' +
      'is the receiver EXECUTING such a command. Mirroring the bare-LF discipline: any ' +
      'rejection (4yz/5yz or a dropped connection) is conformant hardening and blesses the ' +
      'server — a NUL in a reverse-path is a classic injection/smuggling primitive and a ' +
      'server that refuses it is exactly what we want to certify. Only a 2yz/3yz acceptance, ' +
      'which "uses" the forbidden octet, is the violation. A control octet (not a high-bit ' +
      'one) is chosen so no negotiated extension (8BITMIME/SMTPUTF8) can lawfully permit it.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;

      // MAIL FROM with a raw NUL (0x00) embedded in the local-part. The command is
      // otherwise well-formed; the only thing wrong with it is the forbidden octet.
      await conn.send(crlf`MAIL FROM:<pr${0x00}obe@conformance-suite.invalid>`);
      return classifyControlCharUse(conn);
    },
  }),

  testCase({
    id: 'invalid-char-command-rejected-501',
    requirement: 'R-5321-4.1.2-n',
    alsoTouches: ['R-5321-4.1.2-j'],
    intent: 'a command with an invalid character code, unimpeachable otherwise, is rejected with 501',
    rationale:
      '§4.1.2: "SMTP servers that receive a command in which invalid character codes have been ' +
      'employed, and for which there are no other reasons for rejection, MUST reject that ' +
      'command with a 501 response". The register note is explicit that this is one of the few ' +
      'places 5321 names an EXACT code rather than a class: a 500 or a 550 is a genuine miss, ' +
      'not latitude, so unlike R-5321-2.4-l this asserts 501, not merely 5yz. Two traps the ' +
      'probe is built to avoid: (a) "no other reasons for rejection" — the command is a MAIL ' +
      'FROM with a null-ish path, so there is no mailbox-existence or relay reason to hide ' +
      'behind, only the one bad octet; (b) the SMTPUTF8 carve-out lifts the non-ASCII ' +
      'restriction, so we use a C0 control octet (BEL, 0x07), which no extension makes legal. ' +
      'A 2yz/3yz acceptance also violates this (it must be REJECTED); a 4yz temp failure or a ' +
      'dropped connection is inconclusive, not a conviction.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greetAndEhlo(conn);
      if (bad !== null) return bad;

      // MAIL FROM with a raw BEL (0x07) in the local-part — an invalid character
      // code in an otherwise clean command (no other reason for rejection).
      await conn.send(crlf`MAIL FROM:<pr${0x07}obe@conformance-suite.invalid>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') {
        return { kind: 'inconclusive', reason: 'invalid-char MAIL drew no reply within the timeout (server may be slow, §4.5.3.2)' };
      }
      if (r.kind !== 'reply') {
        // A dropped connection is a refusal, but it is not observably a 501 and not
        // observably an acceptance — we cannot judge the SPECIFIC-code duty on it.
        return { kind: 'inconclusive', reason: `invalid-char MAIL drew ${r.kind}, not a reply — cannot judge the 501 duty` };
      }
      const sev = severity(r.reply);
      if (sev === 2 || sev === 3) {
        return {
          kind: 'violated',
          detail: `server ACCEPTED (${r.reply.code}) a command containing an invalid character code — §4.1.2 requires it be rejected with 501`,
        };
      }
      if (r.reply.code === 501) {
        return { kind: 'satisfied', detail: 'invalid-char command rejected with 501, as required' };
      }
      if (sev === 4) {
        return { kind: 'inconclusive', reason: `invalid-char MAIL drew a 4yz temp failure (${r.reply.code}); not evidence of the 501 duty either way` };
      }
      // A 5yz that is not 501 (500, 550, ...). Per the register note, the code here
      // is exact, so this is a genuine miss, not permitted latitude.
      return {
        kind: 'violated',
        detail: `invalid-char command rejected with ${r.reply.code}, not the 501 that §4.1.2 specifically requires`,
      };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'command-verb-case-insensitive',
    defect: 'requireUppercaseVerbs',
    why: 'rejecting a lower-case command verb that is accepted upper-case violates §2.4 (R-5321-2.4-a)',
  },
  {
    catches: 'control-char-in-mail-not-executed',
    defect: 'acceptControlCharsInCommand',
    why: 'executing a MAIL command that carries a control octet violates §4.1.2-j (R-5321-4.1.2-j)',
  },
  {
    catches: 'invalid-char-command-rejected-501',
    defect: 'acceptControlCharsInCommand',
    why: 'accepting a command with an invalid character code instead of the required 501 violates §4.1.2 (R-5321-4.1.2-n)',
  },
];
