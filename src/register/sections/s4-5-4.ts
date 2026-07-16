/**
 * RFC 5321 §4.5.4 / §4.5.4.1 / §4.5.4.2 / §4.5.5 —
 * Retry Strategies, Sending Strategy, Receiving Strategy, and Messages with a
 * Null Reverse-Path.
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Scope note: almost every requirement in §4.5.4/§4.5.4.1 binds the SENDING
 * side — queuing, retry timing, negative-response caching, transaction
 * batching. This suite connects *to* a server and observes only receiver
 * behaviour, so nearly all of these are `not-testable` (client-binding). They
 * are registered anyway: deleting the sender's obligations would shrink the
 * denominator and flatter our coverage. The one genuinely wire-observable
 * requirement in the whole range is §4.5.4.2's prose rule that a server
 * handling only one transaction at a time is non-conformant.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_5_4 = [
  // --- §4.5.4 Retry Strategies -------------------------------------------
  {
    id: 'R-5321-4.5.4-a',
    section: '4.5.4',
    page: 66,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Any queuing strategy MUST include timeouts on all activities on a ' +
      'per-command basis.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender\'s outbound queuing subsystem — an internal design ' +
        'constraint on the client\'s own message queue. Nothing about whether ' +
        'a peer queue enforces per-command timeouts is visible to a party ' +
        'connecting to the server as a client.',
    },
  },
  {
    id: 'R-5321-4.5.4-b',
    section: '4.5.4',
    page: 66,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'A queuing strategy MUST NOT send error messages in response to error ' +
      'messages under any circumstances.',
    testability: {
      kind: 'not-testable',
      reason:
        'A mail-loop-prevention rule binding the queuing/bounce-generating ' +
        'side. Observing a violation would require getting the peer to ' +
        'generate an error message in reply to one we sent it, which arrives ' +
        '(if at all) as a separate outbound delivery, out of band from this ' +
        'suite\'s single client connection.',
    },
  },

  // --- §4.5.4.1 Sending Strategy -----------------------------------------
  {
    id: 'R-5321-4.5.4.1-a',
    section: '4.5.4.1',
    page: 66,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'mail that\n' +
      'cannot be transmitted immediately MUST be queued and periodically\n' +
      'retried by the sender.',
    testability: {
      kind: 'not-testable',
      reason:
        'Explicitly binds "the sender". Queuing and periodic retry are ' +
        'client-side behaviours with no wire signature observable by a party ' +
        'acting as the client.',
    },
    note:
      'Quoted continuously across the "the program that composes ... " ' +
      'sentence; the clause "mail that cannot be transmitted immediately ' +
      'MUST be queued and periodically retried by the sender" is the ' +
      'normative core.',
  },
  {
    id: 'R-5321-4.5.4.1-b',
    section: '4.5.4.1',
    page: 67,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The sender MUST delay retrying a particular destination after one ' +
      'attempt has failed.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds "The sender". Retry timing is client-side scheduling; a server ' +
        'connected to cannot observe how the peer spaces its own retries.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-c',
    section: '4.5.4.1',
    page: 67,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'In general, the retry interval SHOULD be at\n   least 30 minutes;',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side retry timing, and doubly advisory ("In general" + ' +
        'SHOULD). Not observable from the server side.',
    },
    note:
      'Quoted up to the semicolon to stop cleanly before the "however, more ' +
      'sophisticated ..." qualifier, which is non-normative colour.',
  },
  {
    id: 'R-5321-4.5.4.1-d',
    section: '4.5.4.1',
    page: 67,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'the give-up time generally needs to be at least 4-5 days.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side retry-horizon guidance. Not observable over a client ' +
        'connection to a server.',
    },
    note:
      'BORDERLINE. Registered as `prose` at SHOULD force, but the hedge is ' +
      'heavy: "generally needs to be" is weaker than a 2119 SHOULD and is ' +
      'close to pure description. Included for denominator honesty (it does ' +
      'set a floor on give-up time) with this caveat; a reasonable reader ' +
      'could omit it as non-normative.',
  },
  {
    id: 'R-5321-4.5.4.1-e',
    section: '4.5.4.1',
    page: 67,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'It MAY be appropriate to set a shorter maximum number of retries for ' +
      'non-delivery notifications and equivalent error messages than for ' +
      'standard messages.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side retry-count permission. A discretionary sender policy ' +
        'with nothing on the wire corresponding to taking or declining it.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-f',
    section: '4.5.4.1',
    page: 67,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The parameters to the retry algorithm MUST be\n   configurable.',
    testability: {
      kind: 'not-testable',
      reason:
        'A configurability requirement on the client\'s retry algorithm — an ' +
        'operational/product property, not a wire behaviour, and client-side ' +
        'in any case.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-g',
    section: '4.5.4.1',
    page: 67,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'A client SHOULD keep a list of hosts it cannot reach and\n' +
      '   corresponding connection timeouts, rather than just retrying queued\n' +
      '   mail items.',
    testability: {
      kind: 'not-testable',
      reason:
        'Explicitly "A client". Internal caching of unreachable hosts has no ' +
        'server-observable signature.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-h',
    section: '4.5.4.1',
    page: 67,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP clients SHOULD use great care in caching\n' +
      '   negative responses from servers.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds "SMTP clients" and concerns how the client caches responses ' +
        'internally — not observable by the server they connect to.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-i',
    section: '4.5.4.1',
    page: 67,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: '5yz\n   responses to the MAIL command MUST NOT be cached.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client\'s caching of MAIL responses. Whether a client ' +
        'reuses a stale 5yz across connections is invisible to the server.',
    },
    note:
      'Quoted from "5yz responses ..." rather than the leading "More ' +
      'significantly," so the quote is the requirement itself; still unique ' +
      'in the document.',
  },
  {
    id: 'R-5321-4.5.4.1-j',
    section: '4.5.4.1',
    page: 68,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'only one copy of the message\n   SHOULD be transmitted.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side batching optimisation: when the client itself is the ' +
        'sender it should send one copy for multiple recipients on the same ' +
        'server. Not a receiver behaviour.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-k',
    section: '4.5.4.1',
    page: 68,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the SMTP client SHOULD use the\n' +
      '   command sequence: MAIL, RCPT, RCPT, ..., RCPT, DATA instead of the\n' +
      '   sequence: MAIL, RCPT, DATA, ..., MAIL, RCPT, DATA.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds "the SMTP client": how it orders MAIL/RCPT/DATA for multiple ' +
        'recipients. The command sequence a peer chooses to send is not ' +
        'something the server under test emits.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-l',
    section: '4.5.4.1',
    page: 68,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'if there\n' +
      '   are very many addresses, a limit on the number of RCPT commands per\n' +
      '   MAIL command MAY be imposed.',
    testability: {
      kind: 'not-testable',
      reason:
        'In the Sending Strategy context this permits the CLIENT to cap how ' +
        'many RCPTs it batches per MAIL before splitting into another ' +
        'transaction — a discretionary sender policy.',
    },
    note:
      'Do not confuse with the server-side recipient-buffer limits in ' +
      '§4.5.3.1.8 / §4.5.3.1.10 (the "at least 100 recipients" floor). This ' +
      'sentence sits in §4.5.4.1 Sending Strategy and its "MAY be imposed" ' +
      'refers to the client\'s own batching, hence party=client. The passive ' +
      'voice makes the binding party genuinely ambiguous; noted so a test ' +
      'author does not read it as a server permission.',
  },
  {
    id: 'R-5321-4.5.4.1-m',
    section: '4.5.4.1',
    page: 68,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'This efficiency feature SHOULD be\n   implemented.',
    testability: {
      kind: 'not-testable',
      reason:
        'Refers back to the one-copy-per-server batching feature, a client ' +
        'sending behaviour. Not observable from the receiving side.',
    },
  },
  {
    id: 'R-5321-4.5.4.1-n',
    section: '4.5.4.1',
    page: 68,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the SMTP client MAY support\n' +
      '   multiple concurrent outgoing mail transactions.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client permission to run concurrent OUTGOING transactions. The ' +
        'server-side counterpart (accepting multiple concurrent connections) ' +
        'is §4.5.4.2, registered there.',
    },
  },

  // --- §4.5.4.2 Receiving Strategy ---------------------------------------
  {
    id: 'R-5321-4.5.4.2-a',
    section: '4.5.4.2',
    page: 68,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The SMTP server SHOULD attempt to keep a pending listen on the SMTP\n' +
      '   port (specified by IANA as port 25) at all times.',
    testability: {
      kind: 'not-testable',
      reason:
        'An availability property ("at all times") plus a deployment choice ' +
        '(port 25). A single successful connection shows the server was ' +
        'listening at one instant, but continuous availability cannot be ' +
        'asserted from the wire, and the port is an operational config we do ' +
        'not judge.',
    },
  },
  {
    id: 'R-5321-4.5.4.2-b',
    section: '4.5.4.2',
    page: 68,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Some limit MAY be imposed,',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission for the server to cap concurrent connections — ' +
        'unfailable by definition. The conformance floor it sits against ' +
        '(must handle more than one transaction) is the testable half, ' +
        'R-5321-4.5.4.2-c.',
    },
    note:
      'Quoted with its trailing comma because "Some limit MAY be imposed" ' +
      'introduces the "but servers that cannot handle more than one ..." ' +
      'clause split out as -c.',
  },
  {
    id: 'R-5321-4.5.4.2-c',
    section: '4.5.4.2',
    page: 68,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'servers that cannot handle more than one SMTP\n' +
      '   transaction at a time are not in conformance with the intent of this\n' +
      '   specification.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: no 2119 keyword, but "are not in conformance ' +
      'with the intent of this specification" gives it MUST-NOT-fail force — ' +
      'a server that serialises to one transaction at a time is declared ' +
      'non-conformant. This is the single wire-observable requirement in the ' +
      'whole §4.5.4 range: open a second TCP connection (or begin a second ' +
      'transaction) while the first is mid-flight and assert both are ' +
      'serviced. Watch two false-positive traps: (1) "the intent" softens ' +
      'this — a server under deliberate load-shedding that returns 421 to the ' +
      'second connection is arguably conformant, so treat an explicit ' +
      '4yz-busy reply differently from silently accepting only one; (2) do ' +
      'not require unbounded concurrency — -b explicitly permits a limit, so ' +
      'the assertion is strictly ">1", not "many".',
    deliberatelyUncovered: {
      reason:
        'concerns servers that cannot handle more than one transaction at a time — a property not observable from a single client connection without provoking concurrency the suite does not model.',
      date: '2026-07-16',
    },
  },

  // --- §4.5.5 Messages with a Null Reverse-Path --------------------------
  {
    id: 'R-5321-4.5.5-a',
    section: '4.5.5',
    page: 68,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'All other types of messages (i.e., any message which is not required\n' +
      '   by a Standards-Track RFC to have a null reverse-path) SHOULD be sent\n' +
      '   with a valid, non-null reverse-path.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the message ORIGINATOR/sender: what reverse-path to put in ' +
        'MAIL FROM. This suite is the client, so it chooses the reverse-path ' +
        'rather than observing a peer\'s choice.',
    },
  },
  {
    id: 'R-5321-4.5.5-b',
    section: '4.5.5',
    page: 69,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'such systems SHOULD NOT reply to\n' +
      '   messages with a null reverse-path,',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds automated email processors (auto-responders/MTAs) not to ' +
        'reply to null-reverse-path mail. Any reply would be a fresh outbound ' +
        'message arriving out of band, not a response on this suite\'s client ' +
        'connection; loop-prevention is not observable at SMTP time.',
    },
    note:
      'Split from -c: this SHOULD NOT concerns REPLYING, -c concerns ' +
      'rewriting the reverse-path when FORWARDING — different behaviours. ' +
      'party=server is a judgement call: "such systems" (automated email ' +
      'processors) act as receivers deciding whether to auto-reply, though ' +
      'the reply act itself is a client action. Untestable either way.',
  },
  {
    id: 'R-5321-4.5.5-c',
    section: '4.5.5',
    page: 69,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'they SHOULD NOT add a non-null\n' +
      '   reverse-path, or change a null reverse-path to a non-null one, to\n' +
      '   such messages when forwarding.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds a forwarding MTA\'s rewriting of the reverse-path. The result ' +
        'is visible only in the message as it leaves toward the next hop, ' +
        'downstream of the server, not in any reply on our connection. Would ' +
        'need a receiving sink and an end-to-end relay path.',
    },
    note:
      'lowercase "should be careful" in the preceding sentence ' +
      '("Implementers of automated email processors should be careful ...") ' +
      'is NOT a 2119 keyword and defines no concrete behaviour, so it is ' +
      'deliberately not registered.',
  },
] as const satisfies readonly RequirementDef[];
