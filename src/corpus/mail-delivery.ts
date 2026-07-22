/**
 * The mail delivery path (RFC 5321 §3.3, §4.1.1.3) — fixture-gated.
 *
 * The heart of what a mail server does: accept a valid transaction and reject an
 * undeliverable recipient. Every case here needs operator-declared server state
 * (a recipient the server accepts, one it rejects), so each declares
 * needs.fixture and yields inconclusive when the run has not supplied it — never
 * a false result. Against a real server these are exercised with the operator's
 * real addresses; against the mutant, with its configured recipients.
 *
 * These are the cases whose real value is a run against Postfix/Exim — they are
 * the substance of "does this server deliver mail correctly", which the
 * connection- and syntax-level corpus cannot reach.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf, cat, bare, b, CRLF, EOD } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';

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
  if (m.kind === 'timeout') return { kind: 'inconclusive', reason: 'MAIL drew no reply within the timeout' };
  if (m.kind !== 'reply' || severity(m.reply) !== 2) {
    return { kind: 'inconclusive', reason: `MAIL not accepted: ${m.kind === 'reply' ? m.reply.code : m.kind}` };
  }
  return null;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'valid-recipient-accepted',
    requirement: 'R-5321-3.3-h',
    alsoTouches: ['R-5321-4.1.1.3-g'],
    intent: 'a RCPT for a recipient the server accepts draws a 2yz',
    rationale:
      '§3.3: "If accepted, the SMTP server returns a \\"250 OK\\" reply and stores the ' +
      'forward-path." The "250 OK" duty is conditioned on "If accepted" — so a 2yz acceptance ' +
      'satisfies, a 5yz PERMANENT rejection of a declared-valid recipient is the violation, and ' +
      'a 4yz TEMPORARY deferral (greylisting, ubiquitous per §3.3-d) is neither: the address ' +
      'would be accepted on retry, so it is inconclusive, not a failure. (This mirrors the ' +
      'sibling delivery cases; treating 4yz as violated would fail every greylisting MTA.)',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'RCPT drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RCPT: server ${r.kind} instead of replying` };
      if (severity(r.reply) === 2) return { kind: 'satisfied', detail: `valid recipient accepted (${r.reply.code})` };
      if (severity(r.reply) === 4) return { kind: 'inconclusive', reason: `RCPT deferred with ${r.reply.code} (greylisting) — would be accepted on retry` };
      if (severity(r.reply) === 5) return { kind: 'violated', detail: `server PERMANENTLY rejected a declared-valid recipient with ${r.reply.code}` };
      return { kind: 'inconclusive', reason: `RCPT drew ${r.reply.code}` };
    },
  }),

  testCase({
    id: 'undeliverable-recipient-not-fully-accepted',
    requirement: 'R-5321-3.3-i',
    intent: 'a message to a declared-undeliverable recipient is rejected — at RCPT or, at latest, after DATA',
    rationale:
      '§3.3: "If the recipient is known not to be a deliverable address, the SMTP server ' +
      'returns a 550 reply ... (other circumstances and reply codes are possible)." Two traps ' +
      'the register note flags: (1) assert the 5yz CLASS, never the exact 550 (551/553/554 all ' +
      'occur); (2) the MUST is conditioned on the server KNOWING — a server that does no RCPT-' +
      'time verification and 250s every recipient (anti-harvesting) is NOT violating it, and ' +
      'may reject after DATA or bounce asynchronously. So "the honest scoring is reject-or-' +
      'defer": a 5yz at RCPT OR a rejection after end-of-data is conformant. Only FULL synchronous ' +
      'acceptance of the declared-undeliverable recipient\'s message is the violation — and even ' +
      'that a server could still bounce async, which this suite cannot see — which is exactly why ' +
      'the rejectedRecipient fixture CONTRACT (see fixture.ts) pins it to SYNCHRONOUS in-session ' +
      'rejection: declaring the address asserts the server rejects it within the session, so full ' +
      'end-of-data acceptance is either a real §3.3-i violation or an operator mis-declaration — ' +
      'never a false accusation against a correctly-declared server (a deferring server is simply ' +
      'left undeclared, yielding inconclusive).',
    needs: { fixture: ['rejectedRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RCPT TO:<${conn.fixture.rejectedRecipient!}>`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'RCPT drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RCPT: ${r.kind}` };
      // Rejected up front (any 5yz): conformant.
      if (severity(r.reply) === 5) return { kind: 'satisfied', detail: `rejected at RCPT (${r.reply.code})` };
      // Not a 2yz acceptance either (e.g. 4yz greylist): not evidence of a violation.
      if (severity(r.reply) !== 2) return { kind: 'inconclusive', reason: `RCPT drew ${r.reply.code}` };
      // Accepted at RCPT — the deferred-rejection path §3.3 permits. Send the body
      // and see whether the transaction is ultimately rejected.
      await conn.send(crlf`DATA`);
      const data = await conn.readReply(3000);
      if (data.kind !== 'reply') return { kind: 'inconclusive', reason: `DATA: ${data.kind}` };
      if (severity(data.reply) === 5) return { kind: 'satisfied', detail: `deferred rejection at DATA (${data.reply.code})` };
      if (data.reply.code !== 354) return { kind: 'inconclusive', reason: `DATA drew ${data.reply.code}` };
      await conn.send(cat(crlf`Subject: probe`, crlf``, crlf`body`, EOD));
      const final = await conn.readReply(5000);
      if (final.kind !== 'reply') return { kind: 'inconclusive', reason: `end-of-data: ${final.kind}` };
      if (severity(final.reply) === 2) {
        return { kind: 'violated', detail: `server FULLY ACCEPTED (${final.reply.code}) a message for a recipient the fixture declares it rejects synchronously — no in-session rejection at RCPT, DATA, or end-of-data (§3.3-i; see the rejectedRecipient contract)` };
      }
      return { kind: 'satisfied', detail: `deferred rejection after body (${final.reply.code})` };
    },
  }),

  testCase({
    id: 'accepted-transaction-stored',
    requirement: 'R-5321-3.3-t',
    // The happy path exercises the whole accept-and-store chain, so it legitimately
    // bears on the sibling MUSTs each section states about a successful transaction:
    // MAIL accepted -> 250 (§3.3-c), DATA -> 354 then the buffer (§3.3-r/-v), the
    // <CRLF>.<CRLF> terminator being honoured (§4.1.1.4-e), end-of-data requiring the
    // server to process (§4.1.1.4-k), and a successful process drawing an OK reply
    // (§4.1.1.4-m). Each is wire-with-fixture, so it becomes fixture-gated by this
    // case carrying it; the primary §3.3-t is the one the rejectAcceptedMessage
    // mutant proves teeth on.
    alsoTouches: [
      'R-5321-3.3-r',
      'R-5321-3.3-v',
      'R-5321-3.3-c',
      'R-5321-4.1.1.4-e',
      'R-5321-4.1.1.4-k',
      'R-5321-4.1.1.4-m',
    ],
    intent: 'a complete transaction to a valid recipient is accepted at end-of-data (2yz)',
    rationale:
      '§3.3: "If accepted, the SMTP server returns a 354 Intermediate reply" (to DATA) and ' +
      '"When the end of text is successfully received and stored, the SMTP-receiver sends a ' +
      '\\"250 OK\\" reply." The end-to-end happy path: MAIL, RCPT (valid), DATA→354, body, ' +
      'end-of-data→2yz.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
      const rcpt = await conn.readReply(3000);
      if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) {
        return { kind: 'inconclusive', reason: `RCPT not accepted: ${rcpt.kind === 'reply' ? rcpt.reply.code : rcpt.kind}` };
      }
      await conn.send(crlf`DATA`);
      const data = await conn.readReply(3000);
      if (data.kind === 'timeout') return { kind: 'inconclusive', reason: 'DATA drew no reply within the timeout' };
      if (data.kind !== 'reply') return { kind: 'violated', detail: `DATA: server ${data.kind} instead of 354` };
      // §3.3-t's 250 obligation is conditioned on "successfully received and stored".
      // A 4yz (451/452 queue-write/storage pressure) or a 421 shutdown at DATA means
      // the server has NOT committed to storing the message and owes no 354/250 — it
      // is a transient state, not a violation. Only a 5yz permanent rejection of a
      // fixture-declared-deliverable transaction convicts. (Matches every sibling
      // delivery/DATA case; the register note for §3.3-t says a post-354 5yz is "not
      // a failure of this — the server simply did not store it".)
      if (severity(data.reply) === 4) {
        return { kind: 'inconclusive', reason: `DATA drew a transient ${data.reply.code} (temp deferral/shutdown) — the server has not committed to storing; no 354 owed` };
      }
      if (data.reply.code !== 354) {
        return { kind: 'violated', detail: `DATA drew ${data.reply.code}, not the 354 intermediate reply` };
      }
      await conn.send(cat(crlf`Subject: delivery probe`, crlf``, crlf`body`, EOD));
      const final = await conn.readReply(5000);
      if (final.kind === 'timeout') return { kind: 'inconclusive', reason: 'end-of-data drew no reply within the timeout' };
      if (final.kind !== 'reply') return { kind: 'violated', detail: `end-of-data: server ${final.kind} instead of replying` };
      if (severity(final.reply) === 2) return { kind: 'satisfied', detail: `message accepted at end-of-data (${final.reply.code})` };
      // A 4yz/421 at end-of-data is a temporary deferral (greylist-at-DATA, disk
      // pressure, service shutdown) — the message was not stored, so §3.3-t's 250 is
      // not owed. Inconclusive, not a finding. Only a 5yz convicts.
      if (severity(final.reply) === 4) {
        return { kind: 'inconclusive', reason: `end-of-data drew a transient ${final.reply.code} — the message was not stored (temp deferral/shutdown), so no 250 is owed` };
      }
      return { kind: 'violated', detail: `server rejected a complete valid transaction with a permanent ${final.reply.code}` };
    },
  }),

  testCase({
    id: 'postmaster-local-part-case-insensitive',
    requirement: 'R-5321-4.1.1.3-m',
    intent: 'a RCPT to "Postmaster" in mixed case is treated the same as lowercase "postmaster"',
    rationale:
      '§4.1.1.3: "in a departure from the usual rules for local-parts, the \\"Postmaster\\" ' +
      'string ... is treated as case-insensitive." So RCPT TO:<Postmaster@domain> must fare no ' +
      'worse than <postmaster@domain>. We compare the two spellings: if lowercase is accepted ' +
      'but a mixed-case Postmaster is rejected, the server is treating the reserved local-part ' +
      'case-sensitively — the violation. (If lowercase itself is not accepted, the server has ' +
      'no postmaster to compare against and the case is inconclusive.)',
    needs: { fixture: ['postmaster'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      const pm = conn.fixture.postmaster!;
      const domain = pm.split('@')[1] ?? 'example.com';
      // Lowercase baseline.
      await conn.send(crlf`RCPT TO:<postmaster@${domain}>`);
      const lower = await conn.readReply(3000);
      if (lower.kind !== 'reply' || severity(lower.reply) !== 2) {
        return { kind: 'inconclusive', reason: `lowercase postmaster not accepted (${lower.kind === 'reply' ? lower.reply.code : lower.kind}) — nothing to compare` };
      }
      // Re-establish the reverse-path buffer for the mixed-case comparison, and
      // CHECK it was accepted — a second MAIL FROM can draw a 4yz/5yz (rate limit,
      // duplicate-sender throttle) on an otherwise conformant server, and without
      // this check that setup failure would be misattributed to case sensitivity.
      await conn.send(crlf`RSET`);
      await conn.readReply(3000);
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const mail2 = await conn.readReply(3000);
      if (mail2.kind !== 'reply' || severity(mail2.reply) !== 2) {
        return { kind: 'inconclusive', reason: `could not re-establish the reverse-path buffer (2nd MAIL FROM drew ${mail2.kind === 'reply' ? mail2.reply.code : mail2.kind}) — cannot isolate the case comparison` };
      }
      await conn.send(crlf`RCPT TO:<Postmaster@${domain}>`);
      const mixed = await conn.readReply(3000);
      if (mixed.kind === 'timeout') return { kind: 'inconclusive', reason: 'mixed-case RCPT drew no reply within the timeout' };
      if (mixed.kind !== 'reply') return { kind: 'inconclusive', reason: `mixed-case RCPT: ${mixed.kind}` };
      if (severity(mixed.reply) === 2) return { kind: 'satisfied', detail: 'Postmaster treated case-insensitively' };
      // A 4yz on the mixed-case RCPT is a temporary deferral (greylisting), not
      // evidence of case-sensitive handling — inconclusive, mirroring the sibling
      // recipient cases. Only a 5yz PERMANENT rejection, where lowercase was
      // accepted, is the case-sensitivity violation.
      if (severity(mixed.reply) === 4) {
        return { kind: 'inconclusive', reason: `mixed-case Postmaster deferred with ${mixed.reply.code} (temporary) — not evidence of case sensitivity` };
      }
      return { kind: 'violated', detail: `lowercase postmaster accepted but mixed-case "Postmaster" drew ${mixed.reply.code} — case-sensitive treatment of the reserved local-part` };
    },
  }),

  testCase({
    id: 'mail-data-any-ascii-accepted',
    requirement: 'R-5321-4.1.1.4-c',
    intent: 'a message whose body carries unusual ASCII control octets (NUL, VT, DEL) is not rejected for containing them',
    rationale:
      '§4.1.1.4: "The mail data may contain any of the 128 ASCII character codes, although ' +
      'experience has indicated that use of control characters other than SP, HT, CR, and LF may ' +
      'cause problems." So a conformant server CARRIES an odd control octet in the body through; ' +
      'it does not refuse the transaction for containing one. The trap: a 5yz at end-of-data is ' +
      'also the canonical site of content/policy filtering, which the RFC permits, so this isolates ' +
      'the octets by first sending a plain-ASCII control message to the same recipient. Only if the ' +
      'plain body is accepted AND the control-bearing body is then permanently rejected is the ' +
      'rejection attributable to the octets (a §4.1.1.4-c violation); a 4yz is transient, inconclusive.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      // greetEhloMail already sent MAIL FROM. Establish the recipient + DATA, send a
      // plain control body first, and read the end-of-data reply.
      const oneTransaction = async (body: Buffer): Promise<import('../conformance/test-case.ts').ReplyOutcome> => {
        await conn.send(crlf`RCPT TO:<${conn.fixture.validRecipient!}>`);
        const rcpt = await conn.readReply(3000);
        if (rcpt.kind !== 'reply' || severity(rcpt.reply) !== 2) return rcpt;
        await conn.send(crlf`DATA`);
        const data = await conn.readReply(3000);
        if (data.kind !== 'reply' || data.reply.code !== 354) return data;
        await conn.send(cat(body, EOD));
        return conn.readReply(5000);
      };
      // Baseline: a plain, well-formed body to the same recipient. If this is itself
      // rejected the server refuses this transaction for reasons unrelated to the body
      // octets, so the octet MUST cannot be isolated; inconclusive, not a finding.
      const baseline = await oneTransaction(cat(crlf`Subject: baseline`, crlf``, crlf`ordinary body`));
      if (baseline.kind !== 'reply') return { kind: 'inconclusive', reason: `baseline transaction: ${baseline.kind}` };
      if (severity(baseline.reply) !== 2) {
        return { kind: 'inconclusive', reason: `a plain control message was itself rejected (${baseline.reply.code}); the server refuses this transaction for reasons unrelated to the body octets` };
      }
      // Re-open a second transaction on the same connection.
      await conn.send(crlf`MAIL FROM:<probe@conformance-suite.invalid>`);
      const m2 = await conn.readReply(3000);
      if (m2.kind !== 'reply' || severity(m2.reply) !== 2) {
        return { kind: 'inconclusive', reason: `could not re-open a transaction for the control-body probe (2nd MAIL drew ${m2.kind === 'reply' ? m2.reply.code : m2.kind})` };
      }
      // The probe: a body line carrying NUL (0x00), VT (0x0b) and DEL (0x7f); ASCII
      // control codes §4.1.1.4-c says a server must be able to receive.
      const controlBody = cat(crlf`Subject: control octets`, crlf``, bare`ctl`, b(0x00, 0x0b, 0x7f), CRLF);
      const probe = await oneTransaction(controlBody);
      if (probe.kind !== 'reply') return { kind: 'inconclusive', reason: `control-body transaction: ${probe.kind}` };
      if (severity(probe.reply) === 2) return { kind: 'satisfied', detail: 'a body with unusual ASCII control octets was accepted' };
      if (severity(probe.reply) === 4) return { kind: 'inconclusive', reason: `control-body message drew a transient ${probe.reply.code}, not a permanent octet rejection` };
      return { kind: 'violated', detail: `a body with ASCII control octets drew ${probe.reply.code} where a plain body was accepted; the message was rejected for containing octets §4.1.1.4-c requires a server to receive` };
    },
  }),

  testCase({
    id: 'vrfy-does-not-falsely-verify',
    requirement: 'R-5321-7.3-a',
    alsoTouches: ['R-5321-7.3-c', 'R-5321-3.5.3-a', 'R-5321-3.5.3-b'],
    intent: 'VRFY of a certainly-nonexistent address does not draw a 250 that falsely signals verification',
    rationale:
      '§7.3: "implementations ... MUST NOT appear to have verified addresses that are not, in ' +
      'fact, verified", and §3.5.3: "A server MUST NOT return a 250 code in response to a VRFY ' +
      'or EXPN command unless it has actually verified the address." So a 250 to a syntactically ' +
      'valid but certainly-nonexistent address is the violation. Every OTHER reply is conformant: ' +
      'declining VRFY with 502/500 (anti-harvesting, standard), 252 "cannot VRFY", or a 550/551 ' +
      'rejection all satisfy; only a 250 falsely asserts a verification that cannot have happened ' +
      'for an address at a reserved .invalid domain the server is not authoritative for.',
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
      await conn.send(crlf`VRFY no-such-user-9f3a2b@conformance-suite.invalid`);
      const r = await conn.readReply(3000);
      if (r.kind === 'timeout') return { kind: 'inconclusive', reason: 'VRFY drew no reply within the timeout' };
      if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `VRFY: ${r.kind}` };
      if (r.reply.code === 250) {
        return { kind: 'violated', detail: `VRFY of a certainly-nonexistent address drew 250; the server appears to have verified an address it cannot have verified (§7.3, §3.5.3)` };
      }
      return { kind: 'satisfied', detail: `VRFY of a nonexistent address drew ${r.reply.code}, not a false 250` };
    },
  }),

  testCase({
    id: 'hundred-recipients-buffered',
    requirement: 'R-5321-4.5.3.1.8-a',
    alsoTouches: ['R-5321-4.5.3.1.8-b'],
    intent: 'a transaction may name up to 100 recipients without any being rejected for recipient count',
    rationale:
      '§4.5.3.1.8: "The minimum total number of recipients that MUST be buffered is 100 ' +
      'recipients", and "Rejection of messages (for excessive recipients) with fewer than 100 ' +
      'RCPT commands is a violation." So issuing up to 100 RCPTs (the fixture recipient, repeated) ' +
      'must not draw a count-based rejection. The isolation: the FIRST RCPT must be accepted; a ' +
      'later one drawing a rejection where the identical earlier address was accepted can only be ' +
      'a recipient-count rejection (nothing else changed), which below 100 is the violation. A ' +
      'server that accepts all 100 satisfies; a 4yz on the very first RCPT is a transient/greylist ' +
      'condition, inconclusive.',
    needs: { fixture: ['validRecipient'] },
    run: async (conn): Promise<Judgement> => {
      const bad = await greetEhloMail(conn);
      if (bad !== null) return bad;
      const rcpt = conn.fixture.validRecipient!;
      // First recipient: must be accepted so a later rejection isolates count.
      await conn.send(crlf`RCPT TO:<${rcpt}>`);
      const first = await conn.readReply(3000);
      if (first.kind !== 'reply') return { kind: 'inconclusive', reason: `first RCPT: ${first.kind}` };
      if (severity(first.reply) !== 2) {
        return { kind: 'inconclusive', reason: `the first RCPT was not accepted (${first.reply.code}); cannot isolate recipient count` };
      }
      // Recipients 2..100. Any rejection here, where #1 was accepted, is a
      // count-based rejection below the mandated floor of 100.
      for (let i = 2; i <= 100; i++) {
        await conn.send(crlf`RCPT TO:<${rcpt}>`);
        const r = await conn.readReply(3000);
        if (r.kind === 'timeout') return { kind: 'inconclusive', reason: `RCPT #${i} drew no reply within the timeout` };
        if (r.kind !== 'reply') return { kind: 'inconclusive', reason: `RCPT #${i}: ${r.kind}` };
        if (severity(r.reply) !== 2) {
          return { kind: 'violated', detail: `RCPT #${i} drew ${r.reply.code} where the identical first recipient was accepted; a recipient-count rejection below the mandated floor of 100 (§4.5.3.1.8)` };
        }
      }
      return { kind: 'satisfied', detail: '100 recipients accepted without a count-based rejection' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  { catches: 'valid-recipient-accepted', defect: 'rejectValidRecipient', why: 'rejecting a valid recipient with 550 violates R-5321-3.3-h' },
  { catches: 'undeliverable-recipient-not-fully-accepted', defect: 'acceptRejectedRecipient', why: 'fully accepting a message for a known-undeliverable recipient violates R-5321-3.3-i' },
  { catches: 'accepted-transaction-stored', defect: 'rejectAcceptedMessage', why: 'rejecting a complete valid transaction at end-of-data violates R-5321-3.3-t' },
  { catches: 'postmaster-local-part-case-insensitive', defect: 'postmasterCaseSensitive', why: 'rejecting mixed-case Postmaster while accepting lowercase violates R-5321-4.1.1.3-m' },
  { catches: 'mail-data-any-ascii-accepted', defect: 'rejectAsciiControlInData', why: 'rejecting a message for carrying an ASCII control octet in the body violates R-5321-4.1.1.4-c (the mail data may contain any of the 128 ASCII codes)' },
  { catches: 'vrfy-does-not-falsely-verify', defect: 'vrfyFalselyVerifies', why: 'answering VRFY of a certainly-nonexistent address with 250 falsely signals verification, violating R-5321-7.3-a' },
  { catches: 'hundred-recipients-buffered', defect: 'rejectRecipientsBefore100', why: 'rejecting recipients for count with fewer than 100 RCPTs violates R-5321-4.5.3.1.8-a/-b' },
];
