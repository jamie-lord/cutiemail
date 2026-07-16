/**
 * RFC 5321 §4.4 — Trace Information
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Scope note for this section: almost everything here governs what a receiver
 * writes INTO the message (Received: / Return-Path: header fields) as it hands
 * the message onward, or what a system does when generating bounce/notification
 * mail. This suite connects to a server as a client and observes only its reply
 * codes on the live connection — it never sees the delivered message, the next
 * hop's envelope, or an out-of-band bounce. So the dominant testability verdict
 * here is `not-testable`, and honestly so: covering these would need a receiving
 * sink and an end-to-end path (a different tool). The one genuine wire target is
 * the partial-delivery DATA reply (R-5321-4.4-x).
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_4 = [
  {
    id: 'R-5321-4.4-a',
    section: '4.4',
    page: 57,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When an SMTP server receives a message for delivery or further ' +
      'processing, it MUST insert trace ("time stamp" or "Received") ' +
      'information at the beginning of the message content, as discussed in ' +
      'Section 4.1.1.4.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A receiving sink the server relays to, so the delivered content can be ' +
        'read back. The prepended trace line is invisible from the client socket ' +
        'but observable at the next hop: the delivered content begins with a ' +
        'Received: line. The mutant relay harness (verifySinkControls, defect ' +
        'dontPrependReceived) provides this; a real server needs to be configured ' +
        'to relay to our sink. Assert only the presence/leading position of a ' +
        'Received: line (b-f detail internals we do not fail on).',
    },
    note:
      'The keystone obligation of the section; every following structural rule ' +
      '(b through f) elaborates what this inserted line must look like, and all ' +
      'inherit the same downstream-observability problem. NOW TESTABLE for the ' +
      'presence/position via the receiving sink (decision 0005); corpus case ' +
      'received-trace-inserted-on-relay asserts it. The b-f internal-format rules ' +
      'remain not-testable (we deliberately do not fail on Received-line details).',
  },
  {
    id: 'R-5321-4.4-b',
    section: '4.4',
    page: 57,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'This line MUST be structured as follows:',
    testability: {
      kind: 'not-testable',
      reason:
        'A chapeau MUST introducing the FROM/ID/FOR structure rules that ' +
        'follow. Like the line itself, the structure is only visible in the ' +
        'delivered message, not on the connection.',
    },
    note:
      'Registered separately from a-f because it carries its own MUST; the ' +
      'substantive constraints are the bulleted clauses c, d, e, f.',
  },
  {
    id: 'R-5321-4.4-c',
    section: '4.4',
    page: 57,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The FROM clause, which MUST be supplied in an SMTP environment,',
    testability: {
      kind: 'not-testable',
      reason:
        'Presence of the FROM clause is a property of the Received line the ' +
        'server writes, not observable from the client side of the connection.',
    },
    note:
      'Split from the same sentence as R-5321-4.4-d: the FROM clause "MUST be ' +
      'supplied" (this entry) but its contents only "SHOULD contain" the host ' +
      'name and address literal (d) — different levels, hence separate entries. ' +
      'Quoted with the trailing comma to bound the MUST clause.',
  },
  {
    id: 'R-5321-4.4-d',
    section: '4.4',
    page: 57,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SHOULD contain both (1) the name of the source host as presented in the ' +
      'EHLO command and (2) an address literal containing the IP address of the ' +
      'source, determined from the TCP connection.',
    testability: {
      kind: 'not-testable',
      reason:
        'Contents of the FROM clause of the Received line are downstream of ' +
        'delivery, not on the wire. SHOULD, so even the omission would be ' +
        'permitted latitude.',
    },
  },
  {
    id: 'R-5321-4.4-e',
    section: '4.4',
    page: 57,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The ID clause MAY contain an "@" as suggested in RFC 822, but this is ' +
      'not required.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission about the ID clause of the Received line, which is not ' +
        'visible on the connection. Unfailable in any case (MAY plus explicit ' +
        '"not required").',
    },
  },
  {
    id: 'R-5321-4.4-f',
    section: '4.4',
    page: 57,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the FOR clause appears, it MUST contain exactly one <path> entry, ' +
      'even when multiple RCPT commands have been given.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains the FOR clause of the Received line the server emits — ' +
        'invisible from the client. The following sentence ("Multiple <path>s ' +
        'raise some security issues...") is rationale, not a separate rule.',
    },
  },
  {
    id: 'R-5321-4.4-g',
    section: '4.4',
    page: 57,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'An Internet mail program MUST NOT change or delete a Received: line ' +
      'that was previously added to the message header section.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds any Internet mail program (client or server) handling the ' +
        'message. Whether existing Received lines are preserved is only visible ' +
        'in the forwarded/delivered message, not in connection replies.',
    },
    note:
      'party is `both` because "An Internet mail program" covers originators, ' +
      'relays and delivery agents alike.',
  },
  {
    id: 'R-5321-4.4-h',
    section: '4.4',
    page: 57,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers MUST prepend Received lines to messages;',
    testability: {
      kind: 'not-testable',
      reason:
        'The position of the added Received line is a property of the outbound ' +
        'message, not of any reply we can read on the connection.',
    },
    note:
      'Split from R-5321-4.4-i (the MUST NOT half of the same sentence). ' +
      'Quoted with the trailing semicolon to bound the prepend obligation.',
  },
  {
    id: 'R-5321-4.4-i',
    section: '4.4',
    page: 57,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'they MUST NOT change the order of existing lines or insert Received ' +
      'lines in any other location.',
    testability: {
      kind: 'not-testable',
      reason:
        'Ordering and placement of header lines is observable only in the ' +
        'delivered message, not from the client side.',
    },
  },
  {
    id: 'R-5321-4.4-j',
    section: '4.4',
    page: 57,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers that create Received header fields SHOULD use explicit ' +
      'offsets in the dates (e.g., -0800), rather than time zone names of any ' +
      'type.',
    testability: {
      kind: 'not-testable',
      reason:
        'Date formatting inside the Received header field is not visible on the ' +
        'connection. Would need to inspect the delivered message.',
    },
  },
  {
    id: 'R-5321-4.4-k',
    section: '4.4',
    page: 57,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Local time (with an offset) SHOULD be used rather than UT when feasible.',
    testability: {
      kind: 'not-testable',
      reason:
        'The timestamp value in the Received header field is downstream of ' +
        'delivery, not observable from the client.',
    },
  },
  {
    id: 'R-5321-4.4-l',
    section: '4.4',
    page: 58,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If it is desired to supply a time zone name, it SHOULD be included in a ' +
      'comment.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns the format of the Received header field the server writes, ' +
        'not any observable connection behaviour.',
    },
  },
  {
    id: 'R-5321-4.4-m',
    section: '4.4',
    page: 58,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'This use of return-path is required; mail systems MUST support it.',
    testability: {
      kind: 'not-testable',
      reason:
        'The return-path line is inserted at final delivery, at the beginning ' +
        'of the mail data — visible only in the delivered message, not on the ' +
        'connection. Requires an end-to-end path we do not have.',
    },
    note:
      'The sentence states the obligation twice ("is required" and "MUST ' +
      'support it"); registered once at MUST. party `both` because "mail ' +
      'systems" spans the whole path.',
  },
  {
    id: 'R-5321-4.4-n',
    section: '4.4',
    page: 58,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'any further (forwarding, gateway, or relay) systems MAY remove the ' +
      'return path and rebuild the MAIL command as needed to ensure that ' +
      'exactly one such line appears in a delivered message.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission granted to forwarding/relay systems, acting on the ' +
        'message after it leaves the connection. Nothing on the wire ' +
        'corresponds to taking or declining it.',
    },
  },
  {
    id: 'R-5321-4.4-o',
    section: '4.4',
    page: 58,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'A message-originating SMTP system SHOULD NOT send a message that ' +
      'already contains a Return-path header field.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the originating (client) system. We could deliberately violate ' +
        'it to probe the server, but the sentence constrains the sender; the ' +
        'server-side reaction is not specified here as a testable rule.',
    },
  },
  {
    id: 'R-5321-4.4-p',
    section: '4.4',
    page: 58,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers performing a relay function MUST NOT inspect the message ' +
      'data, and especially not to the extent needed to determine if ' +
      'Return-path header fields are present.',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether a relay inspected the message data is not observable from the ' +
        'client side — only the relay\'s internals or the next hop would show ' +
        'it. Same class as R-5321-2.4-i.',
    },
  },
  {
    id: 'R-5321-4.4-q',
    section: '4.4',
    page: 58,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers making final delivery MAY remove Return-path header fields ' +
      'before adding their own.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission exercised on the message at final delivery; the result ' +
        'is only visible in the delivered message, not on the connection.',
    },
    note:
      '"Return-path" is hyphenated across a line break in the source ' +
      '("Return-" / "path"); quoted rejoined as the normaliser rejoins it.',
  },
  {
    id: 'R-5321-4.4-r',
    section: '4.4',
    page: 58,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'For this to be unambiguous, exactly one return path SHOULD be present ' +
      'when the message is delivered.',
    testability: {
      kind: 'not-testable',
      reason:
        'A property of the message as delivered, observable only downstream of ' +
        'the connection.',
    },
  },
  {
    id: 'R-5321-4.4-s',
    section: '4.4',
    page: 58,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Systems using RFC 822 syntax with non-SMTP transports SHOULD designate ' +
      'an unambiguous address, associated with the transport envelope, to ' +
      'which error reports (e.g., non-delivery messages) should be sent.',
    testability: {
      kind: 'not-testable',
      reason:
        'Explicitly about systems on non-SMTP transports — outside the scope ' +
        'of anything we can drive over an SMTP socket.',
    },
    note:
      'The trailing lowercase "should be sent" is descriptive, not a second ' +
      'RFC 2119 keyword; the normative force is the earlier "SHOULD designate".',
  },
  {
    id: 'R-5321-4.4-t',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'The reverse-path address (as copied into the Return-path) MUST be used ' +
      'as the target of any mail containing delivery error messages.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns where a system directs delivery-error mail it originates — ' +
        'an out-of-band message to a third party, never visible on our ' +
        'connection to the server under test.',
    },
  },
  {
    id: 'R-5321-4.4-u',
    section: '4.4',
    page: 59,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'a gateway from SMTP -> elsewhere SHOULD insert a return-path header ' +
      'field, unless it is known that the "elsewhere" transport also uses ' +
      'Internet domain addresses and maintains the envelope sender address ' +
      'separately.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds a gateway crossing from SMTP to a non-SMTP transport; the ' +
        'inserted header appears on the far, non-SMTP side we cannot observe.',
    },
  },
  {
    id: 'R-5321-4.4-v',
    section: '4.4',
    page: 59,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'a gateway from elsewhere -> SMTP SHOULD delete any return-path header ' +
      'field present in the message, and either copy that information to the ' +
      'SMTP envelope or combine it with information present in the envelope of ' +
      'the other transport system to construct the reverse-path argument to ' +
      'the MAIL command in the SMTP envelope.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds a gateway entering SMTP from another transport; the input ' +
        'message and its manipulation are on the non-SMTP side, not observable ' +
        'from our client connection.',
    },
  },
  {
    id: 'R-5321-4.4-w',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The server must give special treatment to cases in which the processing ' +
      'following the end of mail data indication is only partially successful.',
    testability: {
      kind: 'not-testable',
      reason:
        'A chapeau stating the obligation generally; "special treatment" is ' +
        'unspecified here. Its concrete, testable consequences are the ' +
        'following sentences (R-5321-4.4-x, -y).',
    },
    note:
      'Lowercase "must", so registered as `prose`; the force is a firm MUST ' +
      'framing the partial-success handling that follows.',
  },
  {
    id: 'R-5321-4.4-x',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In such cases, the response to the DATA command MUST be an OK reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction with multiple accepted RCPT recipients where, after DATA, ' +
        'the message can be delivered to some but not all of them — so the ' +
        'server reaches the partial-success state. Requires server-side state ' +
        '(a mix of deliverable and undeliverable-but-accepted recipients under ' +
        'one domain) we cannot create in-band; see task #12.',
    },
    note:
      'The one genuinely observable requirement in this section: on partial ' +
      'success the DATA reply MUST be 2yz, not a failure code. The trap is ' +
      'that most servers reject bad recipients at RCPT time and so never enter ' +
      'partial success — a per-recipient 5yz at RCPT is legitimate and this ' +
      'rule then does not apply. The fixture must force a recipient that is ' +
      'accepted at RCPT yet fails only at delivery. Assert the class (2yz), ' +
      'not a specific code.',
  },
  {
    id: 'R-5321-4.4-y',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, the SMTP server MUST compose and send an "undeliverable mail" ' +
      'notification message to the originator of the message.',
    testability: {
      kind: 'not-testable',
      reason:
        'The undeliverable-mail notification is a separate outbound message ' +
        '(a bounce) sent to the originator out of band — not a reply on the ' +
        'connection we opened. Confirming it would need to receive mail at the ' +
        'originator address.',
    },
  },
  {
    id: 'R-5321-4.4-z',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A single notification listing all of the failed recipients or separate ' +
      'notification messages MUST be sent for each failed recipient.',
    testability: {
      kind: 'not-testable',
      reason:
        'About the content of the outbound bounce message, delivered to the ' +
        'originator out of band. Not observable on our connection.',
    },
  },
  {
    id: 'R-5321-4.4-aa',
    section: '4.4',
    page: 59,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'For economy of processing by the sender, the former SHOULD be used when ' +
      'possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'A preference between two forms of the outbound bounce message; the ' +
        'bounce itself is out of band and unobservable from the client side.',
    },
  },
  {
    id: 'R-5321-4.4-ab',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'All notification messages about undeliverable mail MUST be sent using ' +
      'the MAIL command (even if they result from processing the obsolete ' +
      'SEND, SOML, or SAML commands)',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs how the server emits the bounce onward — its own outbound ' +
        'SMTP transaction to another host, not the connection we hold. We ' +
        'never see the server acting as a client.',
    },
    note:
      'Split from R-5321-4.4-ac (the null-return-path half of the same ' +
      'sentence); quoted up to the closing parenthesis.',
  },
  {
    id: 'R-5321-4.4-ac',
    section: '4.4',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'and MUST use a null return path as discussed in Section 3.6.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains the reverse-path of the outbound bounce the server sends; ' +
        'visible only in the server\'s own outbound transaction, not to us.',
    },
    note:
      'Quoted with the leading "and" for a safely unique substring; the ' +
      'null-return-path rule for notifications, distinct from ab (MAIL command).',
  },
  {
    id: 'R-5321-4.4-ad',
    section: '4.4',
    page: 60,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'but the "obs-" forms, especially two-digit ; years, are prohibited in ' +
      'SMTP and MUST NOT be used.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains the date-time the server writes into the Received/timestamp ' +
        'line — visible only in the delivered message, not on the connection.',
    },
    note:
      'From the ABNF comment on the Stamp production. The quote spans two ' +
      'comment lines, so the leading "; " of the second line survives ' +
      'normalisation between "two-digit" and "years" — quoted as ' +
      '"two-digit ; years" to match. Both "prohibited in SMTP" and "MUST NOT ' +
      'be used" carry the force; registered once.',
  },
  {
    id: 'R-5321-4.4-ae',
    section: '4.4',
    page: 60,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers SHOULD NOT use unregistered ; names.  See Section 8.',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs which Additional-Registered-Clauses names a server writes into ' +
        'the Received line — visible only in the delivered message.',
    },
    note:
      'From the ABNF comment on Additional-Registered-Clauses. Three near-' +
      'identical "SHOULD NOT use unregistered names" comments appear in this ' +
      'section (this one, af, ag); each is made unique by where a comment "; " ' +
      'lands under whitespace normalisation. Here it falls as "unregistered ; ' +
      'names", and the quote is extended through "See Section 8." for further ' +
      'uniqueness.',
  },
  {
    id: 'R-5321-4.4-af',
    section: '4.4',
    page: 60,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers ; SHOULD NOT use unregistered names.',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs which Addtl-Link (Via) names a server writes into the Received ' +
        'line — visible only in the delivered message.',
    },
    note:
      'From the ABNF comment on Addtl-Link. Distinguished from ae and ag by the ' +
      'comment "; " landing as "servers ; SHOULD NOT".',
  },
  {
    id: 'R-5321-4.4-ag',
    section: '4.4',
    page: 61,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers SHOULD NOT ; use unregistered names.',
    testability: {
      kind: 'not-testable',
      reason:
        'Governs which Attdl-Protocol names a server writes into the Received ' +
        'line (the WITH clause) — visible only in the delivered message.',
    },
    note:
      'From the ABNF comment on Attdl-Protocol. Distinguished from ae and af by ' +
      'the comment "; " landing as "SHOULD NOT ; use".',
  },
] as const satisfies readonly RequirementDef[];
