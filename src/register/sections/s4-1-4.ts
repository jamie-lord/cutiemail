/**
 * RFC 5321 §4.1.4 — Order of Commands
 * RFC 5321 §4.1.5 — Private-Use Commands
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Covers lines 2443-2545 of spec/rfc5321.txt (§4.1.4 on pages 44-46, §4.1.5 on
 * page 46). Letters reset per section: §4.1.4 is a..q, §4.1.5 is a..c.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_1_4 = [
  {
    id: 'R-5321-4.1.4-a',
    section: '4.1.4',
    page: 44,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'A session that will contain mail transactions MUST first be ' +
      'initialized by the use of the EHLO command.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client — it obliges the sender to open with EHLO before ' +
        'starting a mail transaction. The reciprocal server behaviour (rejecting ' +
        'MAIL before EHLO with 503) is not stated in this sentence; §4.1.4 says ' +
        'nothing here about the server enforcing it. Our own client should honour ' +
        'this, but nothing on the wire from the server tests it.',
    },
  },
  {
    id: 'R-5321-4.1.4-b',
    section: '4.1.4',
    page: 44,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server SHOULD ' +
      'accept commands for non-mail transactions (e.g., VRFY or EXPN) ' +
      'without this initialization.',
    testability: { kind: 'wire' },
    note:
      'Testable: open a connection and send VRFY (or EXPN) before any EHLO, ' +
      'expect the command to be processed rather than refused with 503. SHOULD, ' +
      'so a 503 is `permitted-latitude`, not a hard failure. Overlaps with the ' +
      'later, more specific SHOULD at R-5321-4.1.4-k (NOOP/HELP/EXPN/VRFY/RSET ' +
      'processed normally even with no EHLO); this one is the general statement, ' +
      'that one names the "not return a 503" consequence. Note many servers ' +
      'restrict VRFY/EXPN for anti-harvesting reasons (§7.3), which is a separate ' +
      'permitted refusal and must not be scored as violating this SHOULD.',
  },
  {
    id: 'R-5321-4.1.4-c',
    section: '4.1.4',
    page: 44,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text: 'An EHLO command MAY be issued by a client later in the session.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client permission to re-issue EHLO mid-session. Nothing on the wire ' +
        'corresponds to the client taking or declining it; the server-side ' +
        'obligation that follows (reset on a mid-session EHLO) is the testable ' +
        'half, registered as R-5321-4.1.4-d.',
    },
  },
  {
    id: 'R-5321-4.1.4-d',
    deliberatelyUncovered: {
      reason:
        'proving a second EHLO clears a partially-built transaction needs a recipient the server accepts to build the pending state first, which is server-side accept state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.1.4',
    page: 44,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If ' +
      'it is issued after the session begins and the EHLO command is ' +
      'acceptable to the SMTP server, the SMTP server MUST clear all buffers ' +
      'and reset the state exactly as if a RSET command had been issued.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A partially-built transaction to observe being cleared: e.g. issue ' +
        'MAIL FROM (and optionally a RCPT), then a second acceptable EHLO, then ' +
        'attempt DATA or RCPT and confirm the server treats the transaction as ' +
        'reset (503 / no pending recipients) rather than continuing it. Needs a ' +
        'recipient the server will accept to build the pending state.',
    },
    note:
      'The observable is that a mid-session EHLO discards any in-progress ' +
      'transaction, identical to RSET. Only reachable when the EHLO is ' +
      '"acceptable" — an EHLO the server rejects instead triggers R-5321-4.1.4-e ' +
      'and R-5321-4.1.4-f (no state change). Clearing internal buffers is not ' +
      'directly visible; infer the reset from subsequent command handling.',
  },
  {
    id: 'R-5321-4.1.4-e',
    section: '4.1.4',
    page: 44,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the EHLO command is not acceptable to the SMTP server, 501, 500, ' +
      '502, or 550 failure replies MUST be returned as appropriate.',
    testability: { kind: 'wire' },
    note:
      'MUST return one of a NAMED set of codes (501, 500, 502, 550) when EHLO is ' +
      'unacceptable. Assert membership in {501,500,502,550}, not a single code — ' +
      '"as appropriate" leaves the choice to the server, so failing a server for ' +
      'picking 550 over 501 would be a false positive. Provoking an unacceptable ' +
      'EHLO in-band is awkward: a syntactically malformed domain argument is the ' +
      'usual lever, but a permissive server may accept it, in which case this ' +
      'requirement simply is not exercised.',
    deliberatelyUncovered: {
      reason:
        'eliciting an "unacceptable EHLO" reliably against an arbitrary server is contrived — servers accept a wide range of EHLO arguments, so a probe designed to be rejected is server-specific and would usually yield inconclusive rather than a clean pass/fail.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.4-f',
    section: '4.1.4',
    page: 44,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The ' +
      'SMTP server MUST stay in the same state after transmitting these ' +
      'replies that it was in before the EHLO was received.',
    testability: { kind: 'wire' },
    note:
      'Sentence begins "The" at the foot of page 44 and completes on page 45; ' +
      'quoted continuously, filed under page 44 where it starts. Distinct from ' +
      'R-5321-4.1.4-e: that one governs the reply code, this one governs state ' +
      'preservation after a REJECTED EHLO. Test by establishing some state ' +
      '(e.g. an open transaction), sending an unacceptable EHLO, and confirming ' +
      'the prior state survives — the opposite of R-5321-4.1.4-d\'s reset on an ' +
      'ACCEPTED EHLO. "State" is not directly observable; infer it from how the ' +
      'next command is handled.',
    deliberatelyUncovered: {
      reason:
        'depends on first eliciting a rejected EHLO (see R-5321-4.1.4-e) and then proving state was preserved; the setup is server-specific and contrived, so deferred rather than risk an inconclusive-heavy or false-positive test.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.4-g',
    section: '4.1.4',
    page: 45,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The SMTP client MUST, if possible, ensure that the domain parameter ' +
      'to the EHLO command is a primary host name as specified for this ' +
      'command in Section 2.3.5.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client (choice of EHLO domain argument), and is softened by ' +
        '"if possible". The server receives whatever we send; there is no server ' +
        'reply that tests the client\'s obligation to pick a primary host name.',
    },
  },
  {
    id: 'R-5321-4.1.4-h',
    section: '4.1.4',
    page: 45,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If this is not possible (e.g., when the client\'s address is ' +
      'dynamically assigned and the client does not have an obvious name), an ' +
      'address literal SHOULD be substituted for the domain name.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side fallback for the EHLO argument when no primary host name is ' +
        'available. Purely a sender decision; nothing the server emits observes ' +
        'it. Note the RFC uses a straight apostrophe in "client\'s".',
    },
  },
  {
    id: 'R-5321-4.1.4-i',
    section: '4.1.4',
    page: 45,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server MAY verify that the domain name argument in the EHLO ' +
      'command actually corresponds to the IP address of the client.',
    testability: {
      kind: 'not-testable',
      reason:
        'Permission for the server to perform an internal check (EHLO domain vs. ' +
        'client IP). Whether it runs the check is not visible on the wire — only ' +
        'a possible downstream refusal would be, and that refusal is explicitly ' +
        'forbidden as a basis by R-5321-4.1.4-j.',
    },
  },
  {
    id: 'R-5321-4.1.4-j',
    section: '4.1.4',
    page: 45,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, if the verification fails, the server MUST NOT refuse to ' +
      'accept a message on that basis.',
    testability: {
      kind: 'not-testable',
      reason:
        'Looks testable (send an EHLO domain that cannot match our IP, then see ' +
        'if mail is accepted) but is not assertable as a failure: we cannot ' +
        'observe the BASIS of any refusal from the wire, only that one occurred. ' +
        'A rejection could rest on spam policy, RBLs, or rate limits rather than ' +
        'EHLO/IP mismatch — the very thing this forbids — and we cannot tell them ' +
        'apart. Nor can we know the server ran the (optional) verification at all. ' +
        'The compliant direction (acceptance) is observable, but a violation is ' +
        'not distinguishable, so we cannot fail a server on it.',
    },
    note:
      'The two sentences that follow in the RFC ("Information captured ... is for ' +
      'logging and tracing purposes" and the "Note that this prohibition applies ' +
      'to the matching of the parameter to its IP address only ...") are ' +
      'clarifications of scope, not separate obligations, so they are not ' +
      'registered. See §7.9 for the broader connection/mail rejection discussion ' +
      'they point to.',
  },
  {
    id: 'R-5321-4.1.4-k',
    section: '4.1.4',
    page: 45,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP ' +
      'servers SHOULD process these normally (that is, not return a 503 ' +
      'code) even if no EHLO command has yet been received;',
    testability: { kind: 'wire' },
    note:
      '"these" = the NOOP, HELP, EXPN, VRFY, and RSET commands named in the ' +
      'preceding sentence (registered only descriptively there, so not a separate ' +
      'entry). Test by sending each of those before any EHLO and asserting the ' +
      'reply is not 503. Quoted with its trailing semicolon to keep it distinct ' +
      'from the client SHOULD that shares the sentence (R-5321-4.1.4-l). SHOULD, ' +
      'so a 503 is `permitted-latitude`; but a 503 to a bare RSET/NOOP is a strong ' +
      'smell. VRFY/EXPN may still be refused for anti-harvesting reasons (a ' +
      'different code, not 503), which is fine.',
  },
  {
    id: 'R-5321-4.1.4-l',
    section: '4.1.4',
    page: 45,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'clients SHOULD ' + 'open a session with EHLO before sending these commands.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client — advice to send EHLO first even for NOOP/HELP/EXPN/' +
        'VRFY/RSET. It is the sender\'s counterpart to the server SHOULD in ' +
        'R-5321-4.1.4-k and produces no server reply that tests it.',
    },
  },
  {
    id: 'R-5321-4.1.4-m',
    section: '4.1.4',
    page: 45,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'MAIL (or SEND, SOML, or SAML) MUST NOT be ' +
      'sent if a mail transaction is already open, i.e., it should be sent ' +
      'only if no mail transaction had been started in the session, or if ' +
      'the previous one successfully concluded with a successful DATA ' +
      'command, or if the previous one was aborted, e.g., with a RSET or new ' +
      'EHLO.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client — it must not issue a nested MAIL while a ' +
        'transaction is open. The reciprocal server behaviour (rejecting a ' +
        'second MAIL with 503) is not stated in this sentence; it derives from ' +
        'the out-of-order rule registered as R-5321-4.1.4-o, which is where the ' +
        'nested-MAIL rejection is actually tested. This entry itself is a client ' +
        'obligation, unobservable from the server\'s replies.',
    },
    note:
      'A common conformance test — send MAIL, then MAIL again without RSET/DATA, ' +
      'expect 503 — asserts the SERVER rule (R-5321-4.1.4-o / the transaction ' +
      'state machine), not this client MUST NOT. Keep the two straight.',
  },
  {
    id: 'R-5321-4.1.4-n',
    section: '4.1.4',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the transaction beginning command argument is not acceptable, a ' +
      '501 failure reply MUST be returned and the SMTP server MUST stay in ' +
      'the same state.',
    testability: { kind: 'wire' },
    note:
      'Two obligations kept in one entry because "the SMTP server MUST stay in ' +
      'the same state" is not a unique substring on its own (the 503 sentence, ' +
      'R-5321-4.1.4-o, ends identically). (1) A malformed transaction-beginning ' +
      'argument (e.g. MAIL FROM:<garbage) MUST get 501; assert code 501 ' +
      'specifically here, as the RFC names it exactly (unlike EHLO in ' +
      'R-5321-4.1.4-e, which lists a set). (2) State must be unchanged after the ' +
      '501 — infer from subsequent command handling. Some servers reply 553/501 ' +
      'variants for bad addresses; watch that latitude when scoring.',
    deliberatelyUncovered: {
      reason:
        'requires an "unacceptable transaction-beginning argument" that a given server actually rejects with 501; which MAIL FROM arguments a server rejects is server-specific, making a portable test contrived.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.4-o',
    section: '4.1.4',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the commands in a transaction are out of order to ' +
      'the degree that they cannot be processed by the server, a 503 failure ' +
      'reply MUST be returned and the SMTP server MUST stay in the same ' +
      'state.',
    testability: { kind: 'wire' },
    note:
      'Sentence starts on page 45 and completes on page 46; filed under 45. ' +
      'Two obligations again kept together for quote uniqueness (see ' +
      'R-5321-4.1.4-n). This is the workhorse: send DATA with no prior MAIL/RCPT, ' +
      'or RCPT with no MAIL, or a second MAIL inside an open transaction, and ' +
      'expect 503 with state unchanged. Caveat the hedge "to the degree that ' +
      'they cannot be processed" — a server that CAN process a particular ' +
      'ordering is not obliged to 503, so pick orderings that are unambiguously ' +
      'unprocessable (DATA before any RCPT is the safest).',
  },
  {
    id: 'R-5321-4.1.4-p',
    section: '4.1.4',
    page: 46,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The last command in a session MUST be the QUIT command.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client — it prescribes how a well-behaved sender ends a ' +
        'session. A server cannot compel it and emits no reply that tests it; a ' +
        'client that just drops the connection violates this silently.',
    },
  },
  {
    id: 'R-5321-4.1.4-q',
    section: '4.1.4',
    page: 46,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The QUIT ' +
      'command SHOULD be used by the client SMTP to request connection ' +
      'closure, even when no session opening command was sent and accepted.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client-side courtesy — send QUIT to close, even after a session that ' +
        'never got past connection open. Purely a sender behaviour; no server ' +
        'reply observes whether the client used QUIT or dropped the socket.',
    },
  },
  {
    id: 'R-5321-4.1.5-a',
    section: '4.1.5',
    page: 46,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'An SMTP server that does not recognize such ' +
      'a command is expected to reply with "500 Command not recognized".',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "is expected to" carries SHOULD-strength force ' +
      'without an RFC 2119 keyword — it defines the conforming response to an ' +
      'unknown X-prefixed (private-use) command. Testable with a bare connection: ' +
      'send a command that no server could know, e.g. XZZFAKE, and expect a 500. ' +
      'Assert the 500 CLASS, not the literal "Command not recognized" text, which ' +
      'is illustrative. Real trap: many servers answer 502 ("Command not ' +
      'implemented") instead of 500 for unknown commands; RFC 5321 elsewhere ' +
      'blesses 500 for "syntax error / command unrecognized" and 502 for ' +
      '"command not implemented", so a 502 here is arguably wrong but widely ' +
      'seen — record the divergence rather than hard-failing without thought.',
  },
  {
    id: 'R-5321-4.1.5-b',
    section: '4.1.5',
    page: 46,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An ' +
      'extended SMTP server MAY list the feature names associated with these ' +
      'private commands in the response to the EHLO command.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission (MAY) with no failure mode, and it presupposes the server ' +
        'has bilaterally-agreed private X-commands to advertise — state we cannot ' +
        'establish in-band. Even if an EHLO response carries unfamiliar keywords, ' +
        'we cannot know they correspond to private commands rather than ordinary ' +
        'extensions, so nothing here is assertable.',
    },
  },
  {
    id: 'R-5321-4.1.5-c',
    section: '4.1.5',
    page: 46,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Commands sent or accepted by SMTP systems that do not start with "X" ' +
      'MUST conform to the requirements of Section 2.2.2.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds both parties ("sent" = client, "accepted" = server) and its ' +
        'substance is a pointer to §2.2.2, whose requirements concern registered ' +
        'extension naming — a non-X command name must be a standardized/registered ' +
        'one. From the wire we cannot distinguish a server accepting a legitimately ' +
        'registered extension from one accepting an unregistered non-X command: we ' +
        'have no oracle for the registry, and the real conformance target lives in ' +
        '§2.2.2. Not scored here; §2.2.2\'s own entries carry any testable part.',
    },
    note:
      'Left as party `both` rather than split: the sent/accepted halves share a ' +
      'single conformance target (§2.2.2) and neither half is independently ' +
      'testable, so a split would add two untestable rows without adding signal.',
  },
] as const satisfies readonly RequirementDef[];
