/**
 * RFC 5321 §6 — Problem Detection and Handling
 * §6.1 Reliable Delivery and Replies by Email
 * §6.2 Unwanted, Unsolicited, and "Attack" Messages
 * §6.3 Loop Detection
 * §6.4 Compensating for Irregularities
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Scope note: almost the whole of §6 binds behaviour we cannot see from a
 * client socket. The reliability, bounce/DSN, silent-drop, loop-detection and
 * message-fixing requirements are either about internal server state (message
 * durability, loop provisions), about messages the server EMITS out-of-band
 * (non-delivery notifications), or about modifications visible only in the
 * delivered/relayed message. This suite observes inbound replies only, so most
 * of §6 lands as `not-testable`. That is honest, not a gap: deleting these
 * would flatter coverage. See src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S6 = [
  {
    id: 'R-5321-6.1-a',
    section: '6.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When the receiver-SMTP accepts a piece of mail (by sending a "250 OK" ' +
      'message in response to DATA), it is accepting responsibility for ' +
      'delivering or relaying the message.',
    testability: {
      kind: 'not-testable',
      reason:
        'Definitional prose: it fixes the MEANING of a 250 response to DATA ' +
        '(acceptance of delivery responsibility) rather than a wire behaviour. ' +
        'The concrete obligations it implies are R-5321-6.1-c/d, none of them ' +
        'observable from the client side.',
    },
    note:
      'DERIVED, hence `prose`: stated as fact, no keyword. It is the premise ' +
      'the following MUST/MUST NOT statements rest on — a 250 after DATA is a ' +
      'commitment. Registered because that premise is itself a conformance ' +
      'claim, but it has no independent wire assertion of its own.',
  },
  {
    id: 'R-5321-6.1-b',
    section: '6.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'It must take this responsibility seriously.',
    testability: {
      kind: 'not-testable',
      reason:
        'Pure exhortation with a lowercase "must" and no checkable content of ' +
        'its own; the testable form is the following R-5321-6.1-c (MUST NOT ' +
        'lose the message for frivolous reasons).',
    },
    note:
      'Lowercase "must", hence `prose`. Aspirational rather than operative — ' +
      'it has force only through the concrete rules that follow it, so it is ' +
      'registered for completeness but carries no assertion a test could fail.',
  },
  {
    id: 'R-5321-6.1-c',
    section: '6.1',
    page: 71,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'It MUST NOT lose the message for frivolous reasons, such as because the ' +
      'host later crashes or because of a predictable resource shortage.',
    testability: {
      kind: 'not-testable',
      reason:
        'Message durability across crashes and resource pressure is a property ' +
        'of the server\'s internal storage/queueing that leaves no trace on an ' +
        'in-band reply. We cannot crash the host or exhaust its resources from ' +
        'a socket, nor observe whether an accepted message survived.',
    },
    note:
      'The keystone reliability MUST NOT of §6. A conformant server that has ' +
      'sent 250 to DATA has promised durability; a test would need to induce a ' +
      'crash/restart and confirm the message still delivers — out of reach for ' +
      'a wire-level suite, and squarely operational.',
  },
  {
    id: 'R-5321-6.1-d',
    section: '6.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If there is a delivery failure after acceptance of a message, the ' +
      'receiver-SMTP MUST formulate and mail a notification message.',
    testability: {
      kind: 'not-testable',
      reason:
        'The notification (a bounce / DSN) is a message the server EMITS to the ' +
        'return path out-of-band, not an inbound reply. Observing it needs a ' +
        'receiving sink for the null-sender mail and a post-acceptance delivery ' +
        'failure to trigger it — a different tool than this client suite.',
    },
    note:
      'First of the DSN cluster (d-i). All of it turns on the server sending ' +
      'mail we would have to catch elsewhere; revisit only if task #12 grows an ' +
      'outbound sink, as R-5321-2.4-d already flags.',
  },
  {
    id: 'R-5321-6.1-e',
    section: '6.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'This notification MUST be sent using a null ("<>") reverse-path in the ' +
      'envelope.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains the envelope of the bounce the server emits (MAIL ' +
        'FROM:<>). Visible only to whoever receives that outbound notification, ' +
        'not to this client. Needs an outbound sink plus a triggered failure.',
    },
    note:
      'The null reverse-path is what stops bounces bouncing (a bounce of a ' +
      'bounce would loop). Observable only from the DSN itself, never from the ' +
      'transaction that caused it.',
  },
  {
    id: 'R-5321-6.1-f',
    section: '6.1',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The recipient of this notification MUST be the address from the envelope ' +
      'return path (or the Return-Path: line).',
    testability: {
      kind: 'not-testable',
      reason:
        'The RCPT of the emitted bounce is observable only at the receiving ' +
        'sink for that notification, not from this client. Needs an outbound ' +
        'sink and a post-acceptance delivery failure.',
    },
  },
  {
    id: 'R-5321-6.1-g',
    section: '6.1',
    page: 72,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'if this address is null ("<>"), the receiver-SMTP MUST NOT send a ' +
      'notification.',
    testability: {
      kind: 'not-testable',
      reason:
        'The absence of an emitted bounce is confirmable only at a sink for the ' +
        'null-sender path over time, not from an inbound reply. Requires an ' +
        'outbound sink and a failed delivery of a null-return-path message.',
    },
    note:
      'The anti-loop counterpart to R-5321-6.1-d: a message with an empty ' +
      'reverse-path (itself typically a bounce) must not itself generate a ' +
      'bounce. Testing it means proving a negative on the outbound side.',
  },
  {
    id: 'R-5321-6.1-h',
    section: '6.1',
    page: 72,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the address is an explicit source route, it MUST be stripped down to ' +
      'its final hop.',
    testability: {
      kind: 'not-testable',
      reason:
        'Applies to the recipient address the server puts on the bounce it ' +
        'emits; visible only in that outbound notification. Also needs a ' +
        'source-routed return path, which R-5321-3.3 deprecates on receive.',
    },
    note:
      'Source routes in the reverse-path are a legacy form the RFC elsewhere ' +
      'tells receivers to ignore/strip; this rule governs how a bounce address ' +
      'is derived from one. Doubly out of reach: outbound-only, and needs a ' +
      'route to be accepted in the first place.',
  },
  {
    id: 'R-5321-6.1-i',
    section: '6.1',
    page: 72,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The notification message MUST be sent using:',
    testability: {
      kind: 'not-testable',
      reason:
        'Illustrative: this MUST introduces the worked "RCPT TO:<user@d>" ' +
        'example demonstrating R-5321-6.1-h (source-route stripping). It binds ' +
        'the same outbound-bounce behaviour, unobservable from this client.',
    },
    note:
      'Quoted with its trailing colon because that is the whole clause on the ' +
      'line; it is the example lead-in for the @a,@b:user@d -> user@d stripping ' +
      'illustration, not an independent obligation. Registered so the MUST is ' +
      'not silently dropped, but it duplicates R-5321-6.1-h in force.',
  },
  {
    id: 'R-5321-6.1-j',
    section: '6.1',
    page: 72,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'a receiver-SMTP MUST seek to minimize the time required to respond to ' +
      'the final <CRLF>.<CRLF> end of data indicator.',
    testability: {
      kind: 'not-testable',
      reason:
        '"seek to minimize the time" states no threshold and no failure ' +
        'boundary, so there is nothing to assert against — any latency is ' +
        'arguably conformant. A test could measure the DATA-terminator ' +
        'response time but could not call any value a violation.',
    },
    note:
      'The rationale is duplicate-suppression: if the server is slow to ack ' +
      'the terminating dot, the client may time out and resend. Real, but ' +
      'unfalsifiable as written — no number, only "seek to minimize". Worth ' +
      'recording a measured latency in the matrix, never worth a pass/fail.',
  },
  {
    id: 'R-5321-6.2-k',
    section: '6.2',
    page: 72,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Utility and predictability of the Internet mail system requires that ' +
      'messages that can be delivered should be delivered, regardless of any ' +
      'syntax or other faults associated with those messages and regardless of ' +
      'their content.',
    testability: {
      kind: 'not-testable',
      reason:
        'A system-level deliverability principle ("can be delivered should be ' +
        'delivered") that is both circular (what "can be delivered" means is ' +
        'the server\'s own policy) and unobservable — confirming actual ' +
        'delivery is not something a client sees on the wire.',
    },
    note:
      'Lowercase "should" inside "requires that", hence `prose` at SHOULD ' +
      'force. A stated design principle in tension with much of the RFC\'s own ' +
      'permission to reject; the very next paragraph concedes it "may not be ' +
      'practical". Not a rule any single reply could be measured against.',
  },
  {
    id: 'R-5321-6.2-l',
    section: '6.2',
    page: 72,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If they cannot be delivered, and cannot be rejected by the SMTP server ' +
      'during the SMTP transaction, they should be "bounced" (returned with ' +
      'non-delivery notification messages) as described above.',
    testability: {
      kind: 'not-testable',
      reason:
        'The bounce is emitted out-of-band after the transaction closes; ' +
        'observing it needs an outbound sink and a post-acceptance failure, ' +
        'same as the R-5321-6.1-d DSN cluster. Not an inbound reply.',
    },
    note:
      'Lowercase "should", hence `prose`. This is the "either delivered or ' +
      'returned" tradition §6.2 goes on to say silent-dropping violates. The ' +
      'behaviour it wants is entirely on the outbound side.',
  },
  {
    id: 'R-5321-6.2-m',
    section: '6.2',
    page: 72,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'As discussed in Section 7.8 and Section 7.9 below, dropping mail without ' +
      'notification of the sender is permitted in practice.',
    testability: {
      kind: 'not-testable',
      reason:
        'Silent dropping is by definition invisible: no notification, no reply, ' +
        'nothing on the wire distinguishes it from delivery. And it is a ' +
        'permission ("permitted"), so nothing corresponds to declining it.',
    },
    note:
      '"is permitted in practice", hence `prose` at MAY force — an ' +
      'acknowledgement, immediately hedged as "extremely dangerous" and a ' +
      'violation of tradition. Unobservable and unfailable both ways.',
  },
  {
    id: 'R-5321-6.2-n',
    section: '6.2',
    page: 73,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'So silent dropping of messages should be considered only in those cases ' +
      'where there is very high confidence that the messages are seriously ' +
      'fraudulent or otherwise inappropriate.',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs an internal decision ("should be considered only") preceding ' +
        'an unobservable action (silent drop). We can see neither the ' +
        'deliberation nor the drop from a client socket.',
    },
    note:
      'Lowercase "should", hence `prose`. Constrains WHEN the R-5321-6.2-m ' +
      'permission may be exercised; both the trigger (confidence in fraud) and ' +
      'the outcome (silent drop) are invisible to us.',
  },
  {
    id: 'R-5321-6.2-o',
    section: '6.2',
    page: 73,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'even if a "drop messages with invalid return addresses" policy is ' +
      'adopted, it SHOULD be applied only when there is near-certainty that ' +
      'the return addresses are, in fact, invalid.',
    testability: {
      kind: 'not-testable',
      reason:
        'Conditioned on the server adopting a return-address-validation policy ' +
        'we cannot induce, and gated on the server\'s internal "near-certainty" ' +
        'about invalidity. The resulting non-delivery is also outbound-only.',
    },
    note:
      'Quoted from "even if" to keep the conditional intact — the SHOULD only ' +
      'bites once the optional drop policy is in force. Establishing an address ' +
      'the server is near-certain is invalid is fixture state we cannot create ' +
      'in-band, and the effect (drop) is unobservable regardless.',
  },
  {
    id: 'R-5321-6.2-p',
    section: '6.2',
    page: 73,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Conversely, if a message is rejected because it is found to contain ' +
      'hostile content (a decision that is outside the scope of an SMTP server ' +
      'as defined in this document), rejection ("bounce") messages SHOULD NOT ' +
      'be sent unless the receiving site is confident that those messages will ' +
      'be usefully delivered.',
    testability: {
      kind: 'not-testable',
      reason:
        'Triggered by content-based rejection, which the RFC itself calls ' +
        'out-of-scope for an SMTP server, so we cannot reliably provoke it. The ' +
        'thing forbidden (sending a bounce) is outbound and invisible to us.',
    },
    note:
      'The backscatter rule: do not bounce spam/malware to a forged return ' +
      'path. Both the precondition (a content decision) and the constrained ' +
      'action (emitting a bounce) sit outside what a client can see or set up.',
  },
  {
    id: 'R-5321-6.2-q',
    section: '6.2',
    page: 73,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The preference and default in these cases is to avoid sending ' +
      'non-delivery messages when the incoming message is determined to contain ' +
      'hostile content.',
    testability: {
      kind: 'not-testable',
      reason:
        'Restates R-5321-6.2-p as the default posture; same unobservable ' +
        'outbound bounce, same out-of-scope content trigger. Nothing on the ' +
        'wire distinguishes "avoided a bounce" from "no failure occurred".',
    },
    note:
      '"The preference and default ... is to avoid", hence `prose` at SHOULD ' +
      'NOT force. Overlaps R-5321-6.2-p deliberately; registered because it ' +
      'states the DEFAULT (not merely the SHOULD NOT) but it adds no separately ' +
      'testable surface.',
  },
  {
    id: 'R-5321-6.3-r',
    section: '6.3',
    page: 73,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers using this technique SHOULD use a large rejection ' +
      'threshold, normally at least 100 Received entries.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An otherwise-deliverable message (valid recipient) carrying a large, ' +
        'controllable number of Received: header fields, so the loop-rejection ' +
        'threshold can be probed. Needs an accepted recipient — server state we ' +
        'cannot establish in-band.',
    },
    note:
      'Two traps. (1) It binds only servers "using this technique" — a server ' +
      'that detects loops some other way, or not by Received-counting, is fully ' +
      'conformant and never trips this, so failing it for accepting many ' +
      'Received headers is a false positive. (2) "at least 100" bounds the ' +
      'threshold from BELOW: a server that accepts 100+ Received entries is ' +
      'behaving correctly; only rejecting well before 100 (a small threshold) ' +
      'is the deviation. A naive test that sends 100 and expects a rejection ' +
      'has the direction backwards. Also SHOULD, so a small threshold is ' +
      'permitted-latitude, not failure.',
  },
  {
    id: 'R-5321-6.3-s',
    section: '6.3',
    page: 73,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Whatever mechanisms are used, servers MUST contain provisions for ' +
      'detecting and stopping trivial loops.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A routing configuration that makes the server forward a message back ' +
        'to itself (or between two hops) so a trivial loop is actually induced ' +
        'and its stopping can be observed. This is relay/routing state that ' +
        'cannot be set up over an SMTP client connection.',
    },
    note:
      'The one MUST in §6.3, but "contain provisions for" is a capability of ' +
      'the server\'s routing, not a wire event. Demonstrating a violation means ' +
      'engineering an actual loop, which needs control of the server\'s ' +
      'next-hop resolution — outside in-band reach. The Received-count path ' +
      '(R-5321-6.3-r) is one such provision but only a SHOULD, so a server ' +
      'could satisfy this MUST by any other means.',
  },
  {
    id: 'R-5321-6.4-t',
    section: '6.4',
    page: 74,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The following changes to a message being processed MAY be applied when ' +
      'necessary by an originating SMTP server, or one used as the target of ' +
      'SMTP as an initial posting (message submission) protocol:',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission to modify the message (add Message-Id/Date/timezone, ' +
        'correct addresses to FQDN), visible only in the delivered/relayed ' +
        'message body and headers, never in the SMTP reply. Also scoped to an ' +
        'originating/submission server, a role, not the receiving MX we probe.',
    },
    note:
      'Introduces three enumerated fixes (message-id when none appears; ' +
      'date/time/timezone when none appears; address correction to FQDN). MAY, ' +
      'and role-scoped to originating/submission servers only. Whether any fix ' +
      'was applied shows only downstream, so we cannot observe the latitude ' +
      'being taken.',
  },
  {
    id: 'R-5321-6.4-u',
    section: '6.4',
    page: 74,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'These changes MUST NOT be applied by an SMTP server that provides an ' +
      'intermediate relay function.',
    testability: {
      kind: 'not-testable',
      reason:
        'Forbids a relay from making the R-5321-6.4-t fixes. A negative about ' +
        'message modification, observable only by comparing the message in and ' +
        'out of the relay — needs an inbound-and-outbound vantage this suite ' +
        'does not have, plus the server acting in a relay role.',
    },
    note:
      'The important half of §6.4 for interoperability: the same fixes an ' +
      'origin/submission server MAY make, a pure relay MUST NOT. Untestable ' +
      'from a client because it is defined by what does NOT change to a message ' +
      'in transit, which we never see both ends of.',
  },
  {
    id: 'R-5321-6.4-v',
    section: '6.4',
    page: 75,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In all cases, documentation SHOULD be provided in trace header fields ' +
      'and/or header field comments for actions performed by the servers.',
    testability: {
      kind: 'not-testable',
      reason:
        'Trace-header/comment documentation appears in the delivered message ' +
        'headers, not in any SMTP reply. Observable only with a receiving sink ' +
        'that captures the final message, not from this client connection.',
    },
    note:
      'Asks servers that DO apply R-5321-6.4-t fixes to record them in trace ' +
      '(Received:) fields or header comments. Verifiable only by inspecting the ' +
      'delivered headers; nothing in-band reveals it.',
  },
] as const satisfies readonly RequirementDef[];
