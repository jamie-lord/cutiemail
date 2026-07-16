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
import { crlf, cat, EOD } from '../wire/bytes.ts';
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
      'that a server could still bounce async, which this suite cannot see. The rejectedRecipient ' +
      'fixture carries the operator\'s assertion that the server is configured to reject it.',
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
        return { kind: 'violated', detail: `server FULLY ACCEPTED (${final.reply.code}) a message for a declared-undeliverable recipient` };
      }
      return { kind: 'satisfied', detail: `deferred rejection after body (${final.reply.code})` };
    },
  }),

  testCase({
    id: 'accepted-transaction-stored',
    requirement: 'R-5321-3.3-t',
    alsoTouches: ['R-5321-3.3-r', 'R-5321-3.3-v'],
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
];

export const MUTANTS: readonly Mutant[] = [
  { catches: 'valid-recipient-accepted', defect: 'rejectValidRecipient', why: 'rejecting a valid recipient with 550 violates R-5321-3.3-h' },
  { catches: 'undeliverable-recipient-not-fully-accepted', defect: 'acceptRejectedRecipient', why: 'fully accepting a message for a known-undeliverable recipient violates R-5321-3.3-i' },
  { catches: 'accepted-transaction-stored', defect: 'rejectAcceptedMessage', why: 'rejecting a complete valid transaction at end-of-data violates R-5321-3.3-t' },
  { catches: 'postmaster-local-part-case-insensitive', defect: 'postmasterCaseSensitive', why: 'rejecting mixed-case Postmaster while accepting lowercase violates R-5321-4.1.1.3-m' },
];
