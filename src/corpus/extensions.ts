/**
 * ESMTP extension conformance — conditional on advertisement.
 *
 * The governing rule (R-5321-4.2.4-c) is that a server MUST NOT advertise a
 * capability it will then refuse. So extension tests are CONDITIONAL: a server
 * not advertising an extension is out of scope for it (inconclusive), never
 * non-conformant. This is the design principle for the whole module — declare
 * the extension in `needs.ehlo` and the runner gates on it.
 *
 * Full STARTTLS command-injection testing (the NO STARTTLS / CVE-2011-0411
 * class — send `STARTTLS\r\nNOOP\r\n` in one segment and prove the injected
 * command is not processed inside TLS) requires completing a TLS handshake,
 * which the mutant server does not yet implement. That case is deferred and
 * tracked; docs/research/smtp-divergence.md §3 has the exact primitive. What is
 * testable now without TLS is the advertise-vs-honour contract: an advertised
 * STARTTLS must not be refused.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, cat } from '../wire/bytes.ts';
import { severity, advertisedExtensions, ehloKeywords } from '../wire/reply.ts';

async function greeting(conn: Conn): Promise<Judgement | null> {
  const g = await conn.readReply(5000);
  if (g.kind !== 'reply' || severity(g.reply) !== 2) {
    return { kind: 'inconclusive', reason: `greeting: ${g.kind === 'reply' ? g.reply.code : g.kind}` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'helo-is-supported',
    requirement: 'R-5321-4.1.1.1-h',
    alsoTouches: ['R-5321-2.2.1-d'],
    intent: 'the server supports HELO and replies with a 2yz',
    rationale:
      '§4.1.1.1: "servers MUST support the HELO command and reply properly to it." HELO is ' +
      'the mandatory fallback for clients that do not speak ESMTP; a server refusing it is ' +
      'non-conformant.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`HELO conformance-suite.invalid`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `HELO drew ${r.kind}` };
      const sev = severity(r.reply);
      if (sev === 2) return { kind: 'satisfied', detail: `HELO accepted with ${r.reply.code}` };
      // A 4yz is a transient/shutdown condition (451 try-again, 421 closing) — not
      // evidence the server lacks HELO, so it is inconclusive.
      if (sev === 4) return { kind: 'inconclusive', reason: `HELO drew a transient ${r.reply.code}` };
      // Only "command not implemented/recognised" (500/502) denies HELO SUPPORT —
      // the clean violation the §2.2.1-d register note names. Any other 5yz means
      // HELO was UNDERSTOOD but refused for a reason unrelated to command support:
      // 550 to our `.invalid` HELO name (Postfix reject_non_fqdn/invalid_helo_
      // hostname anti-spam policy), or 530 STARTTLS-required. Convicting those would
      // false-positive a conformant, HELO-supporting server — so they are
      // inconclusive, not a finding.
      if (r.reply.code === 500 || r.reply.code === 502) {
        return { kind: 'violated', detail: `HELO drew ${r.reply.code} (command not implemented/recognised) — server does not support HELO` };
      }
      return {
        kind: 'inconclusive',
        reason: `HELO drew ${r.reply.code}: understood but refused on policy (e.g. HELO-hostname or STARTTLS-required), not a command-support failure`,
      };
    },
  }),

  testCase({
    id: 'advertised-starttls-is-honoured',
    requirement: 'R-5321-4.2.4-c',
    intent: 'a server advertising STARTTLS does not then refuse the STARTTLS command',
    rationale:
      '§4.2.4: "Extended SMTP systems MUST NOT list capabilities in response to EHLO for ' +
      'which they will return 502 (or 500) replies." If EHLO advertises STARTTLS, the ' +
      'STARTTLS command MUST NOT draw a 502/500. Conditional on STARTTLS being advertised.',
    needs: { ehlo: ['STARTTLS'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO: ${ehlo.kind}` };
      // The runner's ehlo-gate guarantees STARTTLS is advertised, but the runner
      // re-opens the connection after gating, so we re-EHLO here and proceed.
      await conn.send(crlf`STARTTLS`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `STARTTLS drew ${r.kind}` };
      // 502/500 = "advertised but not implemented" = the violation. A 220 (ready)
      // is the honoured case. (We do not complete the handshake here.)
      if (r.reply.code === 502 || r.reply.code === 500) {
        return {
          kind: 'violated',
          detail: `EHLO advertised STARTTLS but the command drew ${r.reply.code}`,
        };
      }
      return { kind: 'satisfied', detail: `advertised STARTTLS honoured (${r.reply.code})` };
    },
  }),

  testCase({
    id: 'starttls-discards-pipelined-plaintext',
    requirement: 'R-3207-4.2-a',
    intent: 'a command pipelined in the same segment as STARTTLS is discarded, not processed (the STARTTLS command-injection defence)',
    rationale:
      'RFC 3207 §4.2: "The server MUST discard any knowledge obtained from the client ... which was ' +
      'not obtained from the TLS negotiation itself." The CVE-2011-0411 injection: a MITM pipelines ' +
      'a plaintext command in the SAME TCP segment as STARTTLS, and a vulnerable server buffers it ' +
      'across the 220 and processes it as if it came from inside TLS. We send "STARTTLS<CRLF>NOOP' +
      '<CRLF>" in ONE write; a conformant server answers only the 220 and then goes silent (awaiting ' +
      'the ClientHello), discarding the buffered NOOP. A reply to the injected NOOP is the ' +
      'violation. Conditional on STARTTLS being advertised.',
    needs: { ehlo: ['STARTTLS'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply' || severity(ehlo.reply) !== 2) {
        return { kind: 'inconclusive', reason: `EHLO: ${ehlo.kind === 'reply' ? ehlo.reply.code : ehlo.kind}` };
      }
      // The injection: STARTTLS and a pipelined NOOP in ONE write, no gap between.
      await conn.send(cat(crlf`STARTTLS`, crlf`NOOP`));
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `STARTTLS drew ${r.kind}` };
      // A non-2yz to STARTTLS means it was refused (that is §4.2.4-c's advertise-vs-
      // honour concern, tested separately) — nothing to say about injection here.
      if (severity(r.reply) !== 2) return { kind: 'inconclusive', reason: `STARTTLS refused with ${r.reply.code} — cannot test the discard` };
      // The decisive check: after the 220 the server MUST be silent (it discarded
      // the buffered NOOP and is waiting for the TLS ClientHello). An SMTP REPLY to
      // the injected command means it processed the plaintext injection. NB: two
      // non-quiet shapes are NOT injection: a hardened server rejects at the
      // STARTTLS command with a 5xx (handled above as inconclusive), and a server
      // that feeds the buffered bytes to its TLS engine emits a TLS alert record
      // (binary, not a 3-digit SMTP reply) — that is not "processing the command as
      // SMTP", so we convict ONLY when the extra bytes are SMTP-reply-shaped.
      const quiet = await conn.expectQuiet(1000);
      const firstByte = quiet.bytes[0];
      const looksLikeSmtpReply = firstByte !== undefined && firstByte >= 0x30 && firstByte <= 0x39;
      if (!quiet.quiet && !looksLikeSmtpReply) {
        return { kind: 'inconclusive', reason: `after 220 the server sent non-SMTP bytes (0x${(firstByte ?? 0).toString(16)}…) — likely a TLS alert on the pipelined bytes, not a processed plaintext command` };
      }
      if (quiet.quiet) {
        // Silence proves only that the command was not processed IN PLAINTEXT. A
        // server that buffers it to replay INSIDE the TLS session is also silent
        // here — that variant needs a completed handshake and is out of scope
        // (docs/decisions/0006). So this satisfied is scoped to the pre-handshake
        // plaintext variant, not a clean bill against the whole CVE-2011-0411 class.
        return { kind: 'satisfied', detail: 'no plaintext reply to the pipelined command — pre-handshake injection not observed (replay-into-TLS variant out of scope)' };
      }
      return {
        kind: 'violated',
        detail: `after 220 to STARTTLS the server replied to the pipelined plaintext command (${quiet.bytes.subarray(0, 3).toString('latin1')}...) — plaintext command injection (CVE-2011-0411 class)`,
      };
    },
  }),

  testCase({
    id: 'unadvertised-registered-command-not-honoured',
    requirement: 'R-5321-4.1.1.1-l',
    intent: 'a registered extension command the server honours must have been advertised in EHLO',
    rationale:
      '§4.1.1.1: "The EHLO response MUST contain keywords ... for all commands not listed as ' +
      '\\"required\\" in Section 4.5.1 excepting only private-use commands." This is the ' +
      'honour-but-not-advertise falsification, the inverse of advertise-but-refuse (§4.2.4). ' +
      'The requirement can only be falsified, never confirmed (nothing on the wire enumerates ' +
      'what a server supports), so we probe a SMALL list of commands with REGISTERED, ' +
      'standardised names — AUTH (RFC 4954), STARTTLS (RFC 3207) — where the §4.1.5 private-use ' +
      'escape hatch cannot apply. A command that is honoured (2yz/3yz) yet absent from the EHLO ' +
      'keywords is the violation; a rejection (5yz) is conformant; probing a command the server ' +
      'DID advertise proves nothing and is skipped.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply' || severity(ehlo.reply) !== 2) {
        return { kind: 'inconclusive', reason: `EHLO: ${ehlo.kind === 'reply' ? ehlo.reply.code : ehlo.kind}` };
      }
      const advertised = advertisedExtensions(ehlo.reply);

      // Registered-name probes, each with the exact command line and the reply
      // that would mean "honoured". Only probe the ones NOT advertised.
      const probes = [
        { keyword: 'AUTH', line: crlf`AUTH LOGIN` },
        { keyword: 'STARTTLS', line: crlf`STARTTLS` },
      ];
      let probed = 0;
      for (const p of probes) {
        if (advertised.has(p.keyword)) continue; // advertised -> honouring it is fine
        probed++;
        await conn.send(p.line);
        const r = await conn.readReply(3000);
        if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `${p.keyword} probe drew ${r.kind}` };
        const sev = severity(r.reply);
        // 2yz/3yz = the server acted on / entered the command it never advertised.
        if (sev === 2 || sev === 3) {
          return {
            kind: 'violated',
            detail: `${p.keyword} was honoured with ${r.reply.code} but never appeared in the EHLO keywords — a supported non-required command MUST be advertised`,
          };
        }
        // 4yz = transient; can't tell support from a temporary refusal. Reset the
        // transaction footing before the next probe so a lingering state can't skew it.
        if (sev === 4) {
          await conn.send(crlf`RSET`);
          await conn.readReply(3000);
        }
      }
      if (probed === 0) {
        return { kind: 'inconclusive', reason: 'server advertised every registered probe command — nothing unadvertised to falsify against' };
      }
      return { kind: 'satisfied', detail: `${probed} unadvertised registered command(s) correctly refused` };
    },
  }),

  testCase({
    id: 'expn-supported-must-be-advertised',
    requirement: 'R-5321-3.5.2-j',
    intent: 'if EXPN is supported, EXPN appears in the EHLO keyword list',
    rationale:
      '§3.5.2: "if EXPN is supported, it MUST be listed as a service extension in an EHLO ' +
      'response." A falsification (a server supporting EXPN without advertising it), scoped to ' +
      'avoid the false positive: we convict ONLY when EXPN is CLEARLY honoured (a 2yz) yet absent ' +
      'from the EHLO keywords. A 502/500 means EXPN is not supported (nothing to advertise → ' +
      'satisfied); a 550/553 is ambiguous (recognised-but-refused vs generic policy) and a 4yz is ' +
      'transient, so both are inconclusive rather than a finding. EXPN is not in the curated ESMTP ' +
      'keyword set (it doubles as an English word), so this reads the raw EHLO keywords directly.',
    run: async (conn): Promise<Judgement> => {
      const bad = await greeting(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`EHLO conformance-suite.invalid`);
      const ehlo = await conn.readReply(3000);
      if (ehlo.kind !== 'reply' || severity(ehlo.reply) !== 2) {
        return { kind: 'inconclusive', reason: `EHLO: ${ehlo.kind === 'reply' ? ehlo.reply.code : ehlo.kind}` };
      }
      const advertisesExpn = ehloKeywords(ehlo.reply).has('EXPN');
      await conn.send(crlf`EXPN postmaster`);
      const r = await conn.readReply(3000);
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `EXPN drew ${r.kind}` };
      // 502/500 = not implemented -> nothing to advertise.
      if (r.reply.code === 502 || r.reply.code === 500) {
        return { kind: 'satisfied', detail: `EXPN not supported (${r.reply.code}) — no advertisement required` };
      }
      // Only a 250 is genuine list EXPANSION — unambiguous support that MUST be
      // advertised. A 252 ("cannot expand but accepted") is the anti-harvesting
      // decline, NOT the expansion §3.5.2-j means; a 251/553/550/4yz is likewise
      // ambiguous. Convict only the clear 250-unadvertised case; everything else
      // is inconclusive, biasing against a false positive.
      if (r.reply.code === 250) {
        return advertisesExpn
          ? { kind: 'satisfied', detail: `EXPN supported (250) and advertised in EHLO` }
          : { kind: 'violated', detail: `EXPN is supported (drew 250, genuine expansion) but "EXPN" is absent from the EHLO keywords — §3.5.2-j requires it be listed` };
      }
      return { kind: 'inconclusive', reason: `EXPN drew ${r.reply.code} — not a clear 250 expansion (252 anti-harvesting, 550/553 policy, or transient); ambiguous, not convicting` };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'helo-is-supported',
    defect: 'rejectHelo',
    why: 'refusing HELO violates R-5321-4.1.1.1-h (servers MUST support HELO)',
    alsoProves: [
      {
        requirement: 'R-5321-2.2.1-d',
        why: '§2.2.1: "clients and servers MUST support the original HELO mechanisms as a fallback" — the observable server half is exactly "HELO understood", and a 502 (the register note\'s named clean violation, which this defect emits) is the failure',
      },
    ],
  },
  {
    catches: 'advertised-starttls-is-honoured',
    defect: 'advertiseStarttlsButReject',
    why: 'advertising STARTTLS then 502-ing it violates R-5321-4.2.4-c',
  },
  {
    catches: 'unadvertised-registered-command-not-honoured',
    defect: 'honorUnadvertisedAuth',
    why: 'honouring AUTH (a 334 challenge) while never advertising it in EHLO violates R-5321-4.1.1.1-l',
  },
  {
    catches: 'expn-supported-must-be-advertised',
    defect: 'honorUnadvertisedExpn',
    why: 'honouring EXPN (a 250) while never advertising it in EHLO violates R-5321-3.5.2-j',
  },
  {
    catches: 'starttls-discards-pipelined-plaintext',
    defect: 'injectAfterStartTls',
    why: 'processing a command pipelined before the TLS handshake instead of discarding it violates R-3207-4.2-a (CVE-2011-0411)',
  },
];
