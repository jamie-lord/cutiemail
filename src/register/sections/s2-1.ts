/**
 * RFC 5321 §2.1 — Basic Structure
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * §2.1 is architectural narrative, not a command reference: it sets out the
 * client/server picture, the relay/gateway roles, and the handoff of
 * responsibility. Only one RFC 2119 keyword appears in the whole section
 * (the SHOULD about message submission), so almost everything here is
 * `prose` — statements written as description that nevertheless fix
 * conformance. Each such reading is justified in its `note`.
 *
 * The section is also overwhelmingly client-binding, which is why so many
 * entries are `not-testable`. That is the honest shape of §2.1, not a gap in
 * our effort: the one requirement that binds a receiver observably
 * (R-5321-2.1-g) is the only `wire` entry in the section.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_1 = [
  {
    id: 'R-5321-2.1-a',
    section: '2.1',
    page: 7,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'The responsibility of an SMTP client is to transfer mail messages to one ' +
      'or more SMTP servers, or report its failure to do so.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and the obligation it states ("or report its ' +
        'failure to do so") is discharged outside the SMTP connection — to the ' +
        'submitting user or via a bounce. Nothing a server observes tells it ' +
        'whether a client reported its failures.',
    },
    note:
      'DERIVED, hence `prose`: written as a statement of responsibility rather ' +
      'than with a keyword, but it is the charter sentence for client ' +
      'conformance — a client that silently drops mail it cannot deliver is in ' +
      'breach of this and of nothing else in §2.1. Its concrete forms live in ' +
      '§4.5.4.1 (retry) and §6.1 (non-delivery notification); this entry is the ' +
      'general statement they instantiate.',
  },
  {
    id: 'R-5321-2.1-b',
    section: '2.1',
    page: 7,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'SMTP clients that transfer all traffic regardless of the target domains ' +
      'associated with the individual messages, or that do not maintain queues ' +
      'for retrying message transmissions that initially cannot be completed, ' +
      'may otherwise conform to this specification but are not considered ' +
      'fully-capable.',
    testability: {
      kind: 'not-testable',
      reason:
        'Defines a conformance CLASS ("fully-capable") rather than a wire ' +
        'behaviour. Whether a client maintains a retry queue is invisible to ' +
        'the far end of any single connection.',
    },
    note:
      'Registered as `prose` because it is definitional-normative: it does not ' +
      'forbid anything, it establishes the label that R-5321-2.1-c then hangs ' +
      'obligations on. Note the deliberate hedge — such clients "may otherwise ' +
      'conform to this specification". A trap for a test author who reads ' +
      '"not fully-capable" as "non-conforming": it is not. This is the sentence ' +
      'that makes send-only relay clients legal, and any conformance report we ' +
      'emit must not imply otherwise.',
  },
  {
    id: 'R-5321-2.1-c',
    section: '2.1',
    page: 7,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Fully-capable SMTP implementations, including the relays used by these ' +
      'less capable ones, and their destinations, are expected to support all ' +
      'of the queuing, retrying, and alternate address functions discussed in ' +
      'this specification.',
    testability: {
      kind: 'not-testable',
      reason:
        'Queuing, retrying, and alternate-address behaviour are properties of ' +
        'what an implementation does AFTER (or between) connections. A client ' +
        'connecting to a server cannot observe the server\'s own outbound queue ' +
        'or its retry schedule.',
    },
    note:
      '"are expected to" carries the force of a MUST for anything claiming to ' +
      'be fully-capable, hence `prose` at MUST — but it is scoped by the ' +
      'fully-capable label defined in R-5321-2.1-b, so it does not bind every ' +
      'implementation. Note the RFC prints "less capable" unhyphenated here and ' +
      '"less-capable" ten lines later (R-5321-2.1-d); both are quoted as ' +
      'printed. The hyphen difference is real, not a transcription slip, and a ' +
      'normaliser that rejoins hyphenated line breaks will not paper over it.',
  },
  {
    id: 'R-5321-2.1-d',
    section: '2.1',
    page: 7,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'In many situations and configurations, the less-capable clients ' +
      'discussed above SHOULD be using the message submission protocol (RFC ' +
      '4409 [18]) rather than SMTP.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and concerns which protocol/port it chose before ' +
        'the connection existed. A server on 25 cannot tell whether the client ' +
        'in front of it ought to have been talking to 587 instead.',
    },
    note:
      'The only RFC 2119 keyword in all of §2.1. Doubly hedged — "In many ' +
      'situations and configurations" plus SHOULD — so even as advice it is ' +
      'weak. RFC 4409 is obsoleted by RFC 6409; 5321 cites the old number and ' +
      'we quote it as printed (same convention as R-5321-2.4-n on RFC ' +
      '1652/6152).',
  },
  {
    id: 'R-5321-2.1-e',
    section: '2.1',
    page: 8,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'the protocol requires that a server MUST accept responsibility for ' +
      'either delivering the message or properly reporting the failure to do so ' +
      '(see Sections 6.1, 6.2, and 7.8, below).',
    testability: {
      kind: 'not-testable',
      reason:
        'The single most important requirement in the section and we cannot ' +
        'assert it from a socket. Responsibility is discharged after the 250 — ' +
        'by delivery we cannot see, or by a bounce sent to the return path ' +
        'hours later. The connection observes only the 250 itself, which is the ' +
        'trigger for the obligation rather than evidence of it being met.',
    },
    note:
      'Quoted from mid-sentence at "the protocol requires" — the clause before ' +
      'the colon ("a formal handoff of responsibility for the message occurs") ' +
      'is narration, and the MUST is self-contained from this point. ' +
      'THE TRAP: this looks like the section\'s flagship testable requirement ' +
      'and it is the opposite. It is also the requirement most worth revisiting ' +
      'if task #12 ever grows a receiving sink plus a return-path mailbox we ' +
      'control — the shape of the test would be: accept at end-of-DATA for a ' +
      'recipient that will subsequently fail, then assert a DSN arrives at the ' +
      'MAIL FROM address within a bounded window. That is an end-to-end fixture ' +
      'and a different tool, not a wire assertion, so it stays not-testable ' +
      'until such a harness exists rather than being over-claimed now. ' +
      'Do NOT downgrade this to a test that a server replies 250 to DATA — that ' +
      'asserts nothing about responsibility and would be coverage theatre ' +
      'against the highest-value line in §2.1.',
  },
  {
    id: 'R-5321-2.1-f',
    section: '2.1',
    page: 8,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text:
      'When the same message is sent to multiple recipients, this protocol ' +
      'encourages the transmission of only one copy of the data for all ' +
      'recipients at the same destination (or intermediate relay) host.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client\'s batching strategy. A server sees whatever ' +
        'transaction shape it is given and has no way to know whether the same ' +
        'message was also sent down another connection.',
    },
    note:
      '"encourages" is as soft as normative prose gets, so this is registered ' +
      'at SHOULD rather than MUST. It is the multi-RCPT-per-transaction ' +
      'optimisation. Registered rather than dropped because it is the only ' +
      'place §2.1 speaks to transaction shape, and our own client should follow ' +
      'it. The server-side counterpart — that a server accept multiple RCPT ' +
      'commands in one transaction — is §4.5.3.1.8, not here; do not attach a ' +
      'recipient-count test to this ID.',
  },
  {
    id: 'R-5321-2.1-g',
    section: '2.1',
    page: 8,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The server responds to each command with a reply; replies may indicate ' +
      'that the command was accepted, that additional commands are expected, or ' +
      'that a temporary or permanent error condition exists.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: stated as fact ("The server responds"), but a ' +
      'server that answers some commands and stays mute on others is plainly ' +
      'not conforming — same reading as §2.4\'s "The receiver will take no ' +
      'action until this sequence is received" (R-5321-2.4-f). The one entry in ' +
      '§2.1 that is genuinely assertable with a bare connection: send a command ' +
      '— including an unrecognised one — and assert exactly one reply comes ' +
      'back. THE TRAP is the second clause: assert only that A reply arrives, ' +
      'never which one. The sentence explicitly licenses acceptance, ' +
      'intermediate ("additional commands are expected", i.e. 354/334), 4yz and ' +
      '5yz as equally valid answers, so a test that expects a 2yz here would ' +
      'fail a server for correctly rejecting. Per-command code expectations ' +
      'belong to §4.2 and §4.3.2, not to this ID. Needs a timing bound to ' +
      'assert "responds" (task #9): the failure mode is silence, which only a ' +
      'timeout distinguishes from slowness.',
    deliberatelyUncovered: {
      reason:
        'the note\'s own conclusion: the sole failure mode of "responds to each command with a reply" is SILENCE (no reply), and silence is distinguishable from a slow-but-conformant server only by a timeout — which the suite treats as inconclusive, never a finding (§4.5.3.2). The positive "a reply arrives, of any class" is exercised continuously by every reply-bearing case, but cannot be turned into a negative control (a mutant that stays silent is indistinguishable from a slow server). Per-command code expectations live in §4.2/§4.3.2, not here.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-2.1-h',
    section: '2.1',
    page: 8,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'The dialog is purposely lock-step, one-at-a-time, although this can be ' +
      'modified by mutually agreed upon extension requests such as command ' +
      'pipelining (RFC 2920 [19]).',
    testability: { kind: 'wire-client' },
    note:
      '"purposely lock-step" reads as design commentary but has the force of a ' +
      'MUST NOT on unnegotiated pipelining, hence `prose`. ' +
      'RECLASSIFIED to wire-client (ADR 0008): from the RECEIVER suite this was ' +
      'not-testable — nothing in 5321 makes a server punish a client that sends ' +
      'ahead, and a naive receiver-side probe that fails a server for tolerating ' +
      'early commands is a false positive. But it binds the CLIENT, and our own ' +
      'delivery client is directly observable: the outbound suite drives it and ' +
      'asserts it waits for each reply before the next command. The ' +
      'pipelineWithoutWaiting client-defect is the negative control. The ' +
      'negotiated-pipelining path is RFC 2920 (extension corpus, task #19).',
  },
  {
    id: 'R-5321-2.1-i',
    section: '2.1',
    page: 8,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Once a given mail message has been transmitted, the client may either ' +
      'request that the connection be shut down or may initiate other mail ' +
      'transactions.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client permission. Exercising it or not is a client choice with no ' +
        'conformance consequence; the server duty it implies is registered ' +
        'against §4.1.1.5/§4.1.1.10, not here.',
    },
    note:
      'Lowercase "may", so `prose` rather than `keyword` — the level is MAY in ' +
      'force but this is not an RFC 2119 usage and should not be counted as ' +
      'one. It is the sentence that establishes multiple transactions per ' +
      'connection as legal. Our client SHOULD exercise it: a suite that opens a ' +
      'fresh connection per transaction never probes the reuse path, where ' +
      'state-leak defects live.',
  },
  {
    id: 'R-5321-2.1-j',
    section: '2.1',
    page: 9,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In addition, an SMTP client may use a connection to an SMTP server for ' +
      'ancillary services such as verification of email addresses or retrieval ' +
      'of mailing list subscriber addresses.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client permission to send VRFY/EXPN. It confers no server ' +
        'obligation — §3.5.3 explicitly allows a server to refuse both — so ' +
        'there is nothing here that any server response could violate.',
    },
    note:
      'Lowercase "may", hence `prose`. THE TRAP: this sentence looks like it ' +
      'makes VRFY/EXPN support mandatory and it does not. §3.5.3 permits 252 ' +
      'and 502 replies, and refusing to verify is near-universal modern ' +
      'practice for good anti-harvesting reasons. Any VRFY test belongs to ' +
      '§3.5 and must treat refusal as conforming.',
  },
  {
    id: 'R-5321-2.1-k',
    section: '2.1',
    page: 9,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Usually, intermediate hosts are determined via the DNS MX record, not by ' +
      'explicit "source" routing (see Section 5 and Appendix C and Appendix ' +
      'F.2).',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns how a client resolves a next hop before it opens a ' +
        'connection. Route determination happens entirely in DNS, off the SMTP ' +
        'socket, so this suite cannot observe it at all.',
    },
    note:
      'Registered at SHOULD, not MUST NOT: "Usually" is a hedge, and here §2.1 ' +
      'only describes the source-route deprecation that §3.6.1 and Appendix C ' +
      'state normatively. Included because it is a directional statement about ' +
      'conforming client behaviour rather than pure narration, but it is the ' +
      'weakest entry in the section and the real requirement is §3.6.1 — ' +
      'attach any source-route test there. ' +
      'SCOPE NOTE for whoever revisits this: I deliberately did not register ' +
      'the earlier "An SMTP client determines the address of an appropriate ' +
      'host running an SMTP server by resolving a destination domain name..." ' +
      '(page 8) or the "usually selected through the use of the domain name ' +
      'service (DNS) Mail eXchanger mechanism" sentence (page 9). Both restate ' +
      'this same MX rule as description, and registering three IDs for one ' +
      'requirement would inflate the denominator with duplicates — the ' +
      'mirror-image dishonesty to dropping untestable entries. Also skipped as ' +
      'non-normative: the ASCII diagram, the relay/gateway role definitions, ' +
      'the "is a local matter, and is not addressed by this document" ' +
      'disclaimer (an explicit NON-requirement), and the "is covered by this ' +
      'document" scoping sentence.',
  },
] as const satisfies readonly RequirementDef[];
