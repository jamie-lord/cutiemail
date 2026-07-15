/**
 * RFC 5321 §5.1 — Locating the Target Host
 * RFC 5321 §5.2 — IPv6 and MX Records
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Extraction note on scope: §5.1 is almost entirely about what a SENDER (or a
 * relay acting as a sender on its outbound leg) does when it resolves a
 * destination — DNS lookups, MX-record ranking, retry ordering, loop
 * avoidance. This suite connects TO a server as a client and can only observe
 * the receiver's replies on the inbound connection. None of the sender-side
 * resolution work happens in response to our connection, so the honest verdict
 * for most of this section is `not-testable`. The one genuinely receiver-facing
 * statement is R-5321-5.1-r (a server that is a designated MX MAY relay /
 * deliver / hand off). The trap to avoid: do NOT try to "test MX sorting" or
 * "test randomization" against the server we dial — that behaviour is on its
 * outbound path, invisible to us, and any test purporting to assert it is
 * meaningless.
 *
 * §5.2 (IPv6 and MX Records) contains no RFC 2119 keywords and no prose that
 * defines conformance — it is advisory design guidance ("Designers ... should
 * study the procedures above", "an IPv6-only client need not attempt to look
 * up A RRs", "preferably, provide mechanisms ...") using lowercase, non-2119
 * wording. It contributes no register entries; recorded here so its absence is
 * a deliberate reading, not an oversight.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S5 = [
  {
    id: 'R-5321-5.1-a',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'a DNS lookup MUST be performed to resolve the domain name (RFC 1035 ' +
      '[2]).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client: once it lexically identifies a delivery ' +
        'domain it must resolve it via DNS. Happens inside the client before ' +
        'any connection; nothing on the inbound socket of the server we dial ' +
        'reflects whether this lookup was performed.',
    },
    note:
      'Quoted with the "(RFC 1035 [2])." reference marker and trailing period ' +
      'as printed. The following sentence ("mechanisms for inferring FQDNs ... ' +
      'are outside of this specification") is a scope statement, not a ' +
      'requirement, and is not registered.',
  },
  {
    id: 'R-5321-5.1-b',
    section: '5.1',
    page: 69,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers used for initial submission of messages SHOULD NOT make ' +
      'such inferences (Message Submission Servers [18] have somewhat more ' +
      'flexibility)',
    testability: {
      kind: 'not-testable',
      reason:
        '"Such inferences" = inferring FQDNs from partial names or local ' +
        'aliases. Whether a submission server does this happens in its own ' +
        'name-resolution / relay logic, not in a reply we can read. Any ' +
        'observable effect (rejecting a partial-domain recipient) is ' +
        'indistinguishable from an ordinary unknown-domain rejection.',
    },
    note:
      'One sentence in the RFC binds two parties at two levels; split into ' +
      'R-5321-5.1-b (submission servers, SHOULD NOT) and R-5321-5.1-c (relay ' +
      'servers, MUST NOT). Quoted with the "(Message Submission Servers [18] ' +
      'have somewhat more flexibility)" parenthetical, since it qualifies the ' +
      'SHOULD NOT for exactly this party.',
  },
  {
    id: 'R-5321-5.1-c',
    section: '5.1',
    page: 69,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'intermediate (relay) SMTP servers MUST NOT make them.',
    testability: {
      kind: 'not-testable',
      reason:
        'Relay servers must not infer FQDNs from partial names. The inference ' +
        'would occur during the relay\'s outbound resolution, off the inbound ' +
        'socket; and a conforming relay that declines to infer is not ' +
        'observably different from one that simply cannot resolve the name.',
    },
    note:
      'Second half of the sentence split at R-5321-5.1-b. "make them" refers ' +
      'back to "such inferences" (FQDN inference from partial names/aliases).',
  },
  {
    id: 'R-5321-5.1-d',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If a non-existent domain error is returned, this situation MUST be ' +
      'reported as an error.',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs how the sending client reacts to an NXDOMAIN from its own DNS ' +
        'lookup. The error handling is internal to the sender; the server we ' +
        'connect to plays no part in it.',
    },
  },
  {
    id: 'R-5321-5.1-e',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If a temporary error is returned, the message MUST be queued and ' +
      'retried later (see Section 4.5.4.1).',
    testability: {
      kind: 'not-testable',
      reason:
        'Sender-side queue-and-retry behaviour on a temporary DNS failure. ' +
        'Requires observing the sender\'s queue over time, not a socket reply.',
    },
  },
  {
    id: 'R-5321-5.1-f',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If MX records are present, but none of them are usable, or the ' +
      'implicit MX is unusable, this situation MUST be reported as an error.',
    testability: {
      kind: 'not-testable',
      reason:
        'Sender-side handling of an unusable MX / implicit-MX set. Internal to ' +
        'the resolving client; not visible on the receiver socket.',
    },
    note:
      'Distinct from R-5321-5.1-h despite near-identical wording: this entry ' +
      'includes "or the implicit MX is unusable" (line 3844-3846); R-5321-5.1-h ' +
      'is the shorter restatement at line 3851-3852. Both are separate ' +
      'sentences in the RFC and each is quoted verbatim as it appears.',
  },
  {
    id: 'R-5321-5.1-g',
    section: '5.1',
    page: 69,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If one or more MX RRs are found for a given name, SMTP systems MUST ' +
      'NOT utilize any address RRs associated with that name unless they are ' +
      'located using the MX RRs',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains how the sending SMTP system uses DNS results (MX RRs vs ' +
        'bare A/AAAA RRs). A resolution-time decision internal to the sender; ' +
        'no wire event exposes it.',
    },
    note:
      'Quoted up to "the MX RRs" and stopping before the semicolon; the clause ' +
      'that follows ("the \\"implicit MX\\" rule above applies only if there ' +
      'are no MX records present") restates the earlier implicit-MX rule and is ' +
      'not itself a fresh requirement. "MUST NOT" is split across a line break ' +
      'in the source ("MUST" / "NOT"); the normaliser rejoins it.',
  },
  {
    id: 'R-5321-5.1-h',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If MX records are present, but none of them are usable, this situation ' +
      'MUST be reported as an error.',
    testability: {
      kind: 'not-testable',
      reason:
        'Sender-side error handling when every listed MX is unusable. Internal ' +
        'to the resolving client.',
    },
    note:
      'The shorter restatement at line 3851-3852, without the "or the implicit ' +
      'MX is unusable" clause carried by R-5321-5.1-f. Registered separately ' +
      'because it is a distinct sentence; both quote exactly what is printed.',
  },
  {
    id: 'R-5321-5.1-i',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the data field of that response MUST contain a domain name.',
    testability: {
      kind: 'not-testable',
      reason:
        'A constraint on the content of the MX RR the sender looks up (it must ' +
        'name a domain, not an address). This is about DNS data and the ' +
        'sender\'s interpretation of it, not a behaviour of the SMTP server we ' +
        'connect to.',
    },
    note:
      'Full sentence begins "When a domain name associated with an MX RR is ' +
      'looked up and the associated data field obtained, ..."; quoted from "the ' +
      'data field of that response MUST contain a domain name." which is unique ' +
      'in the document.',
  },
  {
    id: 'R-5321-5.1-j',
    section: '5.1',
    page: 69,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'That domain name, when queried, MUST return at least one address ' +
      'record (e.g., A or AAAA RR) that gives the IP address of the SMTP ' +
      'server to which the message should be directed.',
    testability: {
      kind: 'not-testable',
      reason:
        'States what the MX target\'s DNS must resolve to for the sender to ' +
        'proceed. A DNS-data / scope requirement consumed by the sending ' +
        'client; not observable on the receiver socket.',
    },
    note:
      'The next sentence ("Any other response ... lies outside the scope of ' +
      'this Standard") is a scope disclaimer, not a requirement, and is not ' +
      'registered.',
  },
  {
    id: 'R-5321-5.1-k',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the SMTP client MUST be able to try (and retry) each of the relevant ' +
      'addresses in this list in order, until a delivery attempt succeeds.',
    testability: {
      kind: 'not-testable',
      reason:
        'A capability requirement on the sending client (be able to try each ' +
        'delivery address in turn). Concerns the client\'s outbound connection ' +
        'attempts, which the server we dial cannot observe.',
    },
    note:
      'Restated later as "Although the capability to try multiple alternative ' +
      'addresses is required, ..." (line 3898); that is a back-reference to ' +
      'this same MUST and is not registered as a separate entry.',
  },
  {
    id: 'R-5321-5.1-l',
    section: '5.1',
    page: 70,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'there MAY also be a configurable limit on the number of alternate ' +
      'addresses that can be tried.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-configuration permission (cap the number of alternate ' +
        'delivery addresses attempted). A local policy knob on the sender; ' +
        'nothing on the wire corresponds to it.',
    },
  },
  {
    id: 'R-5321-5.1-m',
    section: '5.1',
    page: 70,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'the SMTP client SHOULD try at least two addresses.',
    testability: {
      kind: 'not-testable',
      reason:
        'Sender-side retry policy (attempt at least two of the resolved ' +
        'addresses). Observable only across the client\'s outbound connection ' +
        'attempts, not from the receiver.',
    },
    note:
      'Full sentence: "In any case, the SMTP client SHOULD try at least two ' +
      'addresses." Quoted from "the SMTP client" for a self-contained clause.',
  },
  {
    id: 'R-5321-5.1-n',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'MX records contain a preference indication that MUST be used in ' +
      'sorting if more than one such record appears (see below).',
    testability: {
      kind: 'not-testable',
      reason:
        'Requires the sender to sort candidate hosts by MX preference. A ' +
        'sender-side ranking decision on its outbound path; invisible to the ' +
        'server we connect to.',
    },
  },
  {
    id: 'R-5321-5.1-o',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the sender-SMTP MUST randomize them to spread the load across multiple ' +
      'mail exchangers for a specific organization.',
    testability: {
      kind: 'not-testable',
      reason:
        'Requires the sender to randomize equal-preference MX targets. A ' +
        'sender-side selection behaviour; not observable from the receiver, ' +
        'and even end-to-end it would only be visible statistically.',
    },
    note:
      'Condition stated earlier in the sentence ("If there are multiple ' +
      'destinations with the same preference and there is no clear reason to ' +
      'favor one ..."); quoted from "the sender-SMTP MUST randomize" which ' +
      'carries the obligation and is unique.',
  },
  {
    id: 'R-5321-5.1-p',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'It is the responsibility of the domain name resolver interface to have ' +
      'ordered this list by decreasing preference if necessary',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender\'s DNS resolver interface (a client-side component) ' +
        'to return multihomed addresses in preference order. Internal ' +
        'component behaviour, unobservable on the SMTP wire.',
    },
    note:
      'DERIVED, hence `prose`: no RFC 2119 keyword, but "It is the ' +
      'responsibility of X to ..." states a conformance obligation with the ' +
      'force of MUST. Registered separately from R-5321-5.1-q, which binds the ' +
      'SMTP sender proper rather than the resolver interface.',
  },
  {
    id: 'R-5321-5.1-q',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'the SMTP sender MUST try them in the order presented.',
    testability: {
      kind: 'not-testable',
      reason:
        'Requires the sender to attempt multihomed addresses in the order the ' +
        'resolver returned them. A sender-side outbound ordering decision, not ' +
        'visible to the receiver.',
    },
  },
  {
    id: 'R-5321-5.1-r',
    section: '5.1',
    page: 70,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'it MAY relay the message (potentially after having rewritten the MAIL ' +
      'FROM and/or RCPT TO addresses), make final delivery of the message, or ' +
      'hand it off using some mechanism outside the SMTP-provided transport ' +
      'environment.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'The server under test is the designated Mail eXchanger for the ' +
        'recipient domain we send to, so it accepts the message rather than ' +
        'rejecting it as a non-local / non-relay destination.',
    },
    note:
      'The one receiver-facing statement in §5.1: a server that receives mail ' +
      'for a domain it is a designated MX of. A three-way permission (relay / ' +
      'deliver / hand off), so it is unfailable, and the three options are ' +
      'indistinguishable from the client side — we see only a 250 acceptance, ' +
      'not which path was taken. Expect `permitted-latitude`. Condition quoted ' +
      'from "it MAY relay the message"; the antecedent is "If an SMTP server ' +
      'receives a message with a destination for which it is a designated Mail ' +
      'eXchanger".',
  },
  {
    id: 'R-5321-5.1-s',
    section: '5.1',
    page: 70,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If it determines that it should relay the message without rewriting ' +
      'the address, it MUST sort the MX records to determine candidates for ' +
      'delivery.',
    testability: {
      kind: 'not-testable',
      reason:
        'Describes the MX sorting a relay performs on the DESTINATION\'s ' +
        'records before its own outbound delivery. This is the server acting ' +
        'as a sender on its next hop; none of it appears on the inbound ' +
        'connection we hold.',
    },
    note:
      'Text spans the page 70/71 boundary in spec/rfc5321.txt ("candidates for" ' +
      '/ page break / "delivery."); page recorded as 70, where it starts.',
  },
  {
    id: 'R-5321-5.1-t',
    section: '5.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The relay host MUST then inspect the list for any of the names or ' +
      'addresses by which it might be known in mail transactions.',
    testability: {
      kind: 'not-testable',
      reason:
        'A step in the relay\'s outbound loop-avoidance: inspect the sorted MX ' +
        'list for its own names/addresses. An internal computation on the ' +
        'server\'s sending side, never surfaced on the inbound socket.',
    },
  },
  {
    id: 'R-5321-5.1-u',
    section: '5.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a matching record is found, all records at that preference level ' +
      'and higher-numbered ones MUST be discarded from consideration.',
    testability: {
      kind: 'not-testable',
      reason:
        'Continuation of the relay loop-avoidance algorithm: prune the relay\'s ' +
        'own entry and everything less-preferred. Internal outbound-path logic; ' +
        'unobservable from the receiver socket.',
    },
    note:
      '"higher-numbered" is hyphenated across a line break in some renderings; ' +
      'quoted as the natural single word, which the normaliser also produces.',
  },
  {
    id: 'R-5321-5.1-v',
    section: '5.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If there are no records left at that point, it is an error condition, ' +
      'and the message MUST be returned as undeliverable.',
    testability: {
      kind: 'not-testable',
      reason:
        'The observable outcome of relay loop-avoidance, but "returned as ' +
        'undeliverable" here is an outbound bounce/DSN generated after the ' +
        'relay has accepted the message and failed to find a lower MX. That ' +
        'DSN travels away from us; we would need an out-of-band mail sink to ' +
        'see it, not the inbound connection. (Distinct from synchronous ' +
        '"mail loop" 5xx rejection via Received-header counting in §6.3.)',
    },
  },
  {
    id: 'R-5321-5.1-w',
    section: '5.1',
    page: 71,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If records do remain, they SHOULD be tried, best preference first, as ' +
      'described above.',
    testability: {
      kind: 'not-testable',
      reason:
        'Instructs the relay to try the surviving MX candidates best-preference ' +
        'first on its outbound leg. A sender-side ordering behaviour on the ' +
        'server\'s next hop, invisible to us.',
    },
  },
] as const satisfies readonly RequirementDef[];
