/**
 * RFC 5321 §4.1.1, §4.1.1.1–§4.1.1.4 — Command Semantics: EHLO/HELO, MAIL,
 * RCPT, DATA.
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Scope calls made once here rather than repeated in every note:
 *
 * - ABNF productions (`ehlo`, `helo`, `ehlo-ok-rsp`, `mail`, `rcpt`, `data`)
 *   are not registered as requirements. They are the grammar the surrounding
 *   prose refers to, and the obligation to enforce them lives in §4.1.2
 *   (command argument syntax) and §4.5.1 (minimum implementation). Registering
 *   them here would double-count against whoever extracts those sections.
 *   Where a prose sentence and the grammar disagree — §4.1.1.1's "probably
 *   wise for servers to be prepared" versus `ehlo = "EHLO" SP (Domain /
 *   address-literal) CRLF` — the tension is recorded in the note, because that
 *   is exactly where a naive test fails a conformant server.
 * - Lower-case "must" / "may" / "should" are NOT RFC 2119 keywords: §1.3 scopes
 *   2119 force to the capitalised terms only. They are registered as `prose`
 *   at the level they plainly carry, following the precedent set by
 *   R-5321-2.2.1-c and R-5321-2.3.10-c.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_1_1_A = [
  // ---------------------------------------------------------------------------
  // 4.1.1  Command Semantics and Syntax
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-4.1.1-a',
    section: '4.1.1',
    page: 32,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      '(In the interest of improved interoperability, SMTP receivers SHOULD ' +
      'tolerate trailing white space before the terminating <CRLF>.)',
    testability: { kind: 'wire' },
    note:
      'Quoted with its parentheses because that is how the RFC prints it — the ' +
      'whole requirement is parenthetical, which is a good reminder that ' +
      'normative force does not correlate with typographic prominence. ' +
      'Cheap to test: "NOOP   <CRLF>" and "EHLO host.example  <CRLF>" should ' +
      'be treated as "NOOP" and "EHLO host.example". SHOULD, so a 500/501 is ' +
      '`permitted-latitude`, not failure. ' +
      'TRAP: do not extend this test to leading white space or to internal ' +
      'runs of spaces between arguments — the sentence says trailing only, and ' +
      'the §4.1.2 grammar does not forgive the others.',
  },
  {
    id: 'R-5321-4.1.1-b',
    section: '4.1.1',
    page: 32,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'The syntax of the local part of a mailbox MUST conform to receiver site ' +
      'conventions and the syntax specified in Section 4.1.2.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains an address, not an act either party performs, so there is ' +
        'no wire event that satisfies or violates it directly. Half the ' +
        'conjunct is unknowable in any case: "receiver site conventions" are ' +
        'by definition private to the receiver, and nothing on the wire ' +
        'publishes them. The enforceable consequence — a receiver rejecting a ' +
        'local-part that violates the §4.1.2 grammar — belongs to whoever ' +
        'extracts §4.1.2.',
    },
    note:
      'Registered rather than deferred to §4.1.2 because the MUST is printed ' +
      'here and a reader auditing §4.1.1 must find it. ' +
      'TRAP: this looks like a licence to test "server rejects a malformed ' +
      'local-part", and it is not. The sentence binds the mailbox; a server ' +
      'that liberally accepts a malformed local-part is not observably ' +
      'violating THIS sentence, and "receiver site conventions" gives it an ' +
      'unfalsifiable defence for accepting almost anything. Same shape as ' +
      'R-5321-2.4-c, where the exemplar warns against failing Postfix for ' +
      'being sensible.',
  },
  {
    id: 'R-5321-4.1.1-c',
    section: '4.1.1',
    page: 32,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'These arguments or data objects must be transmitted and held, pending ' +
      'the confirmation communicated by the end of mail data indication that ' +
      'finalizes the transaction.',
    testability: {
      kind: 'not-testable',
      reason:
        'The requirement is that the receiver hold, and not act on, the ' +
        'envelope until <CRLF>.<CRLF> arrives. Holding is internal state. ' +
        'Violation — delivering or forwarding on RCPT — is visible only at the ' +
        'destination or the next hop, which needs a receiving sink and an ' +
        'end-to-end path this suite does not have (cf. R-5321-2.4-d).',
    },
    note:
      'Lower-case "must", hence `prose`; §1.3 scopes 2119 force to the ' +
      'capitalised terms. The force is nonetheless plainly MUST — this is the ' +
      'sentence that makes SMTP transactional. ' +
      'The rest of the paragraph ("The model for this is that distinct buffers ' +
      'are provided...") is explicitly a model, not a requirement, and is not ' +
      'registered: an implementation with no literal buffers conforms so long ' +
      'as it behaves as if it had them. The per-command buffer sentences in ' +
      '§4.1.1.2–§4.1.1.4 ARE registered, because those state observable ' +
      'consequences rather than describe the model.',
  },
  {
    id: 'R-5321-4.1.1-d',
    section: '4.1.1',
    page: 32,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'In the absence of specific extensions offered by the server and ' +
      'accepted by the client, clients MUST NOT send such parameters',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. Our corpus deliberately violates it in order to ' +
        'observe the server half, R-5321-4.1.1-e — the same pattern as ' +
        'R-5321-2.4-g feeding R-5321-2.4-h.',
    },
    note:
      '"such parameters" refers back to the previous sentence: "Several ' +
      'commands (RSET, DATA, QUIT) are specified as not permitting ' +
      'parameters." That sentence is definitional and is not registered on its ' +
      'own — it states what the §4.1.2 grammar already says.',
  },
  {
    id: 'R-5321-4.1.1-e',
    section: '4.1.1',
    page: 32,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'servers SHOULD reject commands containing them as having invalid syntax.',
    testability: { kind: 'wire' },
    note:
      'Split from R-5321-4.1.1-d: one sentence, two parties, and only this ' +
      'half is observable. Test by sending "RSET now", "DATA now" and "QUIT ' +
      'now" with no extension negotiated, expecting a 5yz. ' +
      'TRAP: "as having invalid syntax" invites asserting exactly 501. Assert ' +
      'the class. A server replying 500 has not violated anything, and the ' +
      'SHOULD means accepting the junk is `permitted-latitude` — real servers ' +
      'commonly ignore trailing garbage on RSET. ' +
      'TRAP 2: "DATA now" is the interesting one. A server that accepts it and ' +
      'replies 354 has taken permitted latitude; a server that replies 354 and ' +
      'ALSO treats the parameter as data has done something else entirely.',
  },

  // ---------------------------------------------------------------------------
  // 4.1.1.1  Extended HELLO (EHLO) or HELLO (HELO)
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-4.1.1.1-a',
    section: '4.1.1.1',
    page: 32,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'In situations in which the SMTP client system does not have a ' +
      'meaningful domain name (e.g., when its address is dynamically ' +
      'allocated and no reverse mapping record is available), the client ' +
      'SHOULD send an address literal (see Section 4.1.3).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and its trigger condition ("does not have a ' +
        'meaningful domain name") is a fact about the client host, not ' +
        'anything a server can be measured against.',
    },
    note:
      'Text spans the page 32/33 boundary; quoted continuously and filed under ' +
      'the page it starts on, per EXTRACTING. ' +
      'Relevant to our own client: when the suite runs from a host with no ' +
      'FQDN it should EHLO an address literal rather than invent a name, or it ' +
      'will provoke rejections that look like server defects and are ours.',
  },
  {
    id: 'R-5321-4.1.1.1-b',
    section: '4.1.1.1',
    page: 33,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'it is probably wise for servers to be prepared for this string to occur',
    testability: {
      kind: 'not-testable',
      reason:
        '"probably wise" and "be prepared" are not machine-checkable ' +
        'predicates — the sentence names no reply code, no acceptance, and no ' +
        'tolerance the server owes. It is also directly at odds with the ABNF ' +
        'printed a few lines below it, which admits no trailing string after ' +
        'the Domain, so a 501 is squarely conformant.',
    },
    note:
      'MARGINAL — recorded with reservations, following R-5321-2.2.1-c: the ' +
      'contract says be conservative about dropping things, not about keeping ' +
      'them, and silent omission is the failure mode the register exists to ' +
      'prevent. "this string" is the RFC 2821 habit of following the EHLO ' +
      'domain with client-identifying text. ' +
      'TRAP, and the reason this entry earns its place: someone WILL read this ' +
      'as "servers SHOULD accept EHLO host.example some junk" and write a test ' +
      'that fails every strict server in existence. It cannot be that, because ' +
      '§4.1.1.1\'s own grammar forbids the junk and the sentence itself is ' +
      'double-hedged. If a later reviewer retires this entry, retire it ' +
      'deliberately with a reason, not by deletion.',
  },
  {
    id: 'R-5321-4.1.1.1-c',
    section: '4.1.1.1',
    page: 33,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: 'but SMTP clients SHOULD NOT send it.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. Nothing a server does reveals whether a client took ' +
        'or declined this prohibition.',
    },
    note:
      'Split from R-5321-4.1.1.1-b: same sentence, opposite parties, and only ' +
      'the client half carries a real 2119 keyword. Quoted with the leading ' +
      '"but" to keep the clause boundary honest. ' +
      'Our client MUST honour this — sending trailing identification text would ' +
      'confound every EHLO-response test in the corpus.',
  },
  {
    id: 'R-5321-4.1.1.1-d',
    section: '4.1.1.1',
    page: 33,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The SMTP server identifies itself to the SMTP client in the connection ' +
      'greeting reply and in the response to this command.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: stated as fact, no keyword, but it is plainly a ' +
      'behaviour and it is corroborated by the grammar — `ehlo-ok-rsp` makes ' +
      'the Domain mandatory in both the single-line and multiline forms, and ' +
      '§4.2 does the same for the 220 greeting. A server whose 250 response ' +
      'carries no identity is not doing what this sentence says it does. ' +
      'Testable with a bare connection: read the 220, send EHLO, assert a ' +
      'domain or address literal is present in both. ' +
      'TRAP: do not assert the identity is the SAME in both, do not assert it ' +
      'resolves, and do not assert it matches the connected IP. The RFC says ' +
      'only that the server identifies itself, and §4.1.4 explicitly forbids ' +
      'rejecting on identity mismatch. Presence is the whole assertion.',
  },
  {
    id: 'R-5321-4.1.1.1-e',
    section: '4.1.1.1',
    page: 33,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'A client SMTP SHOULD start an SMTP session by issuing the EHLO command.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. Our client complies by default; the corpus departs ' +
        'from it deliberately when exercising HELO (R-5321-4.1.1.1-h) and the ' +
        'no-greeting case.',
    },
  },
  {
    id: 'R-5321-4.1.1.1-f',
    section: '4.1.1.1',
    page: 33,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the SMTP server, in violation of this specification, does not ' +
      'support any SMTP service extensions, it will generate an error response.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`, and it is the strongest kind of derivation the ' +
      'register admits: the RFC names the contrary behaviour "in violation of ' +
      'this specification" outright, exactly as §2.4 does for case-sensitive ' +
      'verbs (see R-5321-2.4-a). Read as: a server MUST support EHLO. ' +
      'The preceding sentence ("If the SMTP server supports the SMTP service ' +
      'extensions, it will give a successful response, a failure response, or ' +
      'an error response") is not registered — it enumerates every possible ' +
      'outcome and therefore constrains nothing. ' +
      'TRAP: the testable assertion is "EHLO does not draw a 5yz", NOT "EHLO ' +
      'draws 250 with extension keywords". A server may legitimately answer ' +
      'EHLO 250 with no keywords beyond its domain (§4.5.1 requires no ' +
      'extension), and a temporary 4yz is not this violation either. Only a ' +
      '500/502-class refusal of the verb itself convicts.',
  },
  {
    id: 'R-5321-4.1.1.1-g',
    section: '4.1.1.1',
    page: 33,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Older client SMTP systems MAY, as discussed above, use HELO (as ' +
      'specified in RFC 821) instead of EHLO',
    testability: {
      kind: 'not-testable',
      reason:
        'A client permission, and unfailable in any direction. The server-side ' +
        'obligation it implies is R-5321-4.1.1.1-h, which is the testable form.',
    },
  },
  {
    id: 'R-5321-4.1.1.1-h',
    section: '4.1.1.1',
    page: 33,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'servers MUST support the HELO command and reply properly to it.',
    testability: { kind: 'wire' },
    note:
      'One of the cheapest high-value tests in the suite: connect, send "HELO ' +
      'host.example", expect 250. A 500 or 502 is a clean failure. ' +
      'TRAP: "reply properly" is not defined here. Do not assert the reply ' +
      'text, do not assert it is single-line (§4.1.1.1 mandates multiline only ' +
      'for EHLO, but nothing forbids a multiline 250 to HELO), and do not ' +
      'assert HELO suppresses extension keywords. Assert 250 and the presence ' +
      'of the server identity (R-5321-4.1.1.1-d). ' +
      'TRAP 2: some servers accept HELO but then refuse the transaction, or ' +
      'accept HELO only after an EHLO has failed. The MUST is unconditional — ' +
      'test HELO on a fresh connection, not as a fallback.',
  },
  {
    id: 'R-5321-4.1.1.1-i',
    section: '4.1.1.1',
    page: 33,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'In any event, a client MUST issue HELO or EHLO before starting a mail ' +
      'transaction.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. The corresponding server obligation — what to do ' +
        'with a MAIL that arrives before any greeting — is not stated here; ' +
        '§4.1.4 covers it, and it is that section\'s entry that is testable.',
    },
    note:
      'TRAP: this reads like a licence to send MAIL FROM with no EHLO and ' +
      'expect 503. It is not. This sentence binds our client only, and §4.1.4 ' +
      'is notably softer than readers expect about what the server owes here. ' +
      'Any such test must cite the §4.1.4 requirement, not this one.',
  },
  {
    id: 'R-5321-4.1.1.1-j',
    section: '4.1.1.1',
    page: 33,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'These commands, and a "250 OK" reply to one of them, confirm that both ' +
      'the SMTP client and the SMTP server are in the initial state, that is, ' +
      'there is no transaction in progress and all state tables and buffers ' +
      'are cleared.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "confirm that ... buffers are cleared" is ' +
      'phrased as a statement about what the exchange means, but it has the ' +
      'force of MUST — a server that answers 250 to EHLO while retaining a ' +
      'half-built transaction has made the confirmation false. Same reading as ' +
      'R-5321-2.4-f ("The receiver will take no action until this sequence is ' +
      'received"), which the exemplar also took as prose-normative. ' +
      'Testable without a fixture: MAIL FROM:<a@b.example>, then EHLO, then ' +
      'DATA — the DATA must draw a 503, because the forward-path buffer and ' +
      'the transaction are gone. This is the EHLO-as-RSET behaviour, and it is ' +
      'genuinely under-implemented. ' +
      'TRAP: assert the 503 on DATA, not on the EHLO itself. A server is ' +
      'entitled to accept EHLO mid-transaction with 250 — that is precisely ' +
      'what this sentence describes — so a test expecting EHLO to be refused ' +
      'has the requirement backwards.',
  },
  {
    id: 'R-5321-4.1.1.1-k',
    deliberatelyUncovered: {
      reason:
        'needs the server to advertise an EHLO keyword usable in a later command so the keyword can be echoed in a different case and compared, which the mutant does not usefully model and which needs an accepted keyword-bearing command.',
      date: '2026-07-22',
    },
    section: '4.1.1.1',
    page: 34,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Although EHLO keywords may be specified in upper, lower, or mixed case, ' +
      'they MUST always be recognized and processed in a case-insensitive ' +
      'manner.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server that advertises at least one EHLO keyword we can then use in ' +
        'a command or parameter position — e.g. SIZE, 8BITMIME, or a ' +
        'keyword-named command such as STARTTLS — so the keyword can be echoed ' +
        'back in a different case and the treatment compared.',
    },
    note:
      'TRAP, and the sharpest one in this range: EHLO keywords appear in the ' +
      'SERVER\'s response, so the party doing the "recognized and processed" ' +
      'in the primary reading is the CLIENT — and that half is entirely ' +
      'unobservable from where we stand. Registered as `both` rather than ' +
      '`client` because "always" plus the back-reference to §2.4 reaches the ' +
      'server too: a keyword the server advertises must be honoured when the ' +
      'client sends it back in another case (lowercase "starttls", ' +
      '"size=1000"). Only that second reading is testable, and a test must say ' +
      'so rather than claim the requirement is covered. ' +
      'TRAP 2: do not conflate this with R-5321-2.4-a. That one is about the ' +
      'command VERB ("ehlo" vs "EHLO"); this one is about the extension ' +
      'keywords carried in the response and echoed in parameters. Testing ' +
      '"ehlo" in lowercase covers §2.4, not this. ' +
      'Note the hyphen: the RFC line-breaks "case-insensitive" across ' +
      '"case-" / "insensitive"; quoted rejoined, per the normaliser\'s rule.',
  },
  {
    id: 'R-5321-4.1.1.1-l',
    section: '4.1.1.1',
    page: 34,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The EHLO response MUST contain keywords (and associated parameters if ' +
      'required) for all commands not listed as "required" in Section 4.5.1 ' +
      'excepting only private-use commands as described in Section 4.1.5.',
    testability: { kind: 'wire' },
    note:
      'Universally quantified over a set we cannot enumerate — "all commands ' +
      '[the server supports and which are] not listed as required in §4.5.1". ' +
      'Nothing on the wire lists what a server supports, so this requirement ' +
      'can only ever be FALSIFIED, never confirmed. Marked `wire` because ' +
      'falsification needs nothing but a socket: probe a fixed candidate list ' +
      '(STARTTLS, AUTH, SIZE, 8BITMIME, PIPELINING, DSN, CHUNKING, SMTPUTF8), ' +
      'and any command that works but was not advertised convicts. A pass ' +
      'means "not caught", and the report must not round that up to "conforms". ' +
      'TRAP: §4.5.1\'s required list (EHLO, HELO, MAIL, RCPT, DATA, RSET, ' +
      'NOOP, QUIT, VRFY) is what is EXEMPT from advertisement — so a server ' +
      'not advertising VRFY is conformant, and a test that flags it is wrong. ' +
      'TRAP 2: the private-use escape hatch is unfalsifiable. A server caught ' +
      'honouring an unadvertised command can always call it private-use, the ' +
      'same unanswerable defence as "I am a gateway" in R-5321-2.3.10-b. Only ' +
      'a command with a registered, standardised name (STARTTLS, AUTH) closes ' +
      'that door — restrict the probe list accordingly.',
  },
  {
    id: 'R-5321-4.1.1.1-m',
    section: '4.1.1.1',
    page: 34,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Private-use commands MAY be listed.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission with no failing branch — listing and not listing are ' +
        'both conformant. Worse, nothing on the wire marks a keyword as ' +
        'private-use, so we could not establish that the permission was even ' +
        'in play.',
    },
    note:
      'Its real work is on R-5321-4.1.1.1-l, whose exception clause it softens ' +
      'from "must not be listed" to "need not be listed". Kept for that reason.',
  },

  // ---------------------------------------------------------------------------
  // 4.1.1.2  MAIL (MAIL)
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-4.1.1.2-a',
    section: '4.1.1.2',
    page: 34,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In general, the MAIL command may be sent only when no mail transaction ' +
      'is in progress, see Section 4.1.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender ("may be sent only when"), and is hedged with "In ' +
        'general" on top. The server-side obligation to refuse a nested MAIL ' +
        'lives in §4.1.4 and is that section\'s entry to test.',
    },
    note:
      'Lower-case "may", hence `prose` (§1.3). Registered at MUST because ' +
      '"only when" is a restriction, not a permission — the "may" is carrying ' +
      'the negation, and reading the level off the keyword would invert it. ' +
      'TRAP: this is the natural citation for a "MAIL; MAIL -> 503" test, and ' +
      'it is the wrong one twice over: wrong party, and "In general" would ' +
      'excuse the server anyway. Cite §4.1.4.',
  },
  {
    id: 'R-5321-4.1.1.2-b',
    section: '4.1.1.2',
    page: 34,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Historically, that mailbox might optionally have been preceded by a ' +
      'list of hosts, but that behavior is now deprecated (see Appendix C).',
    testability: {
      kind: 'not-testable',
      reason:
        'Deprecation of a sending behaviour. Nothing is said about what a ' +
        'receiver owes a source-routed reverse-path, so there is no server ' +
        'obligation to assert.',
    },
    note:
      'DERIVED, hence `prose`: "is now deprecated" carries SHOULD NOT force ' +
      'without the keyword. ' +
      'Worth noticing that the RCPT twin one section later is explicit — ' +
      '"Sending systems SHOULD NOT generate the optional list of hosts known ' +
      'as a source route" (R-5321-4.1.1.3-a) — and comes with receiver-side ' +
      'obligations (R-5321-4.1.1.3-b/-c). The reverse-path gets no such ' +
      'treatment. That asymmetry is in the RFC, not in this extraction: there ' +
      'is no §4.1.1.2 counterpart to "Receiving systems MUST recognize source ' +
      'route syntax", which leaves a source-routed MAIL FROM formally ' +
      'unaddressed here.',
  },
  {
    id: 'R-5321-4.1.1.2-c',
    section: '4.1.1.2',
    page: 34,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In some types of reporting messages for which a reply is likely to ' +
      'cause a mail loop (for example, mail delivery and non-delivery ' +
      'notifications), the reverse-path may be null (see Section 3.6).',
    testability: {
      kind: 'not-testable',
      reason:
        'Grants the sender a null reverse-path in stated circumstances. The ' +
        'server obligation this implies — that MAIL FROM:<> must be accepted — ' +
        'is not stated here; §3.6 and §6.1 carry it, and those are the ' +
        'testable entries.',
    },
    note:
      'Lower-case "may" (§1.3), hence `prose`. ' +
      'TRAP: MAIL FROM:<> is one of the most valuable things this suite can ' +
      'send — a server that refuses it cannot receive bounces and is broken in ' +
      'a way operators care about — but the requirement backing that test is ' +
      'NOT this sentence. This one only says senders may do it, and only for ' +
      'reporting messages. Cite §6.1.',
  },
  {
    id: 'R-5321-4.1.1.2-d',
    deliberatelyUncovered: {
      reason:
        'proving MAIL clears the forward-path buffer needs a completed transaction (an accepted recipient) and a second MAIL, which is server-side accept state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.1.1.2',
    page: 34,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command clears the reverse-path buffer, the forward-path buffer, ' +
      'and the mail data buffer, and it inserts the reverse-path information ' +
      'from its argument clause into the reverse-path buffer.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts, so a transaction can be completed ' +
        'through <CRLF>.<CRLF> and a second MAIL issued on the same ' +
        'connection with no intervening RSET. Without an acceptable RCPT the ' +
        'forward-path buffer never becomes non-empty and there is nothing to ' +
        'observe being cleared.',
    },
    note:
      'DERIVED, hence `prose`: stated as what the command does, with the force ' +
      'of MUST. Distinguished from the §4.1.1 buffer MODEL (R-5321-4.1.1-c, ' +
      'not registered as behaviour) because clearing has an in-band ' +
      'consequence: DATA must be refused when the forward-path buffer is ' +
      'empty. ' +
      'Test: complete MAIL/RCPT/DATA/., then MAIL again, then DATA with no ' +
      'RCPT — expect 503. ' +
      'TRAP: this test barely attributes. §4.1.1.4 already clears the buffers ' +
      'at end-of-data (R-5321-4.1.1.4-l), so a pass proves only that ONE of ' +
      'the two mechanisms fired. Isolating MAIL\'s own clearing needs a ' +
      'transaction that ended without end-of-data and without RSET, and SMTP ' +
      'offers no such path. Record the entry, and be honest that any test ' +
      'citing it also covers R-5321-4.1.1.4-l and cannot separate them. ' +
      'The insertion half is not separately registered: a reverse-path that ' +
      'failed to land in the buffer is indistinguishable, from the client ' +
      'side, from one that landed and was never looked at.',
  },
  {
    id: 'R-5321-4.1.1.2-e',
    section: '4.1.1.2',
    page: 34,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'If service extensions were negotiated, the MAIL command may also carry ' +
      'parameters associated with a particular service extension.',
    testability: {
      kind: 'not-testable',
      reason:
        'Lower-case permission for the client to use negotiated Mail- ' +
        'parameters. Nothing is failable, and the server-side handling of ' +
        'mail parameters belongs to §4.1.1.11 and the extension corpus ' +
        '(task #19).',
    },
    note:
      'Registered mainly to mark an absence: §4.1.1.3 pairs its identical ' +
      'sentence with "The client MUST NOT transmit parameters other than those ' +
      'associated with a service extension offered by the server in its EHLO ' +
      'response" (R-5321-4.1.1.3-l). §4.1.1.2 has no such prohibition for ' +
      'MAIL. The constraint is generally read across from RCPT, but it is not ' +
      'printed here, and a register that quoted it here would be inventing it.',
  },

  // ---------------------------------------------------------------------------
  // 4.1.1.3  RECIPIENT (RCPT)
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-4.1.1.3-a',
    section: '4.1.1.3',
    page: 35,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Sending systems SHOULD NOT generate the optional list of hosts known as ' +
      'a source route.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender. Our corpus deliberately violates it to exercise ' +
        'R-5321-4.1.1.3-b and -c, which are the observable halves.',
    },
  },
  {
    id: 'R-5321-4.1.1.3-b',
    section: '4.1.1.3',
    page: 35,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Receiving systems MUST recognize source route syntax',
    testability: { kind: 'wire' },
    note:
      'A rare unconditional server MUST that needs no fixture: send RCPT ' +
      'TO:<@hosta.example,@jkl.example:userc@d.example> and assert the reply ' +
      'is not a SYNTAX error. ' +
      'TRAP, and it is the whole test: "recognize" is not "accept". The server ' +
      'may reject the recipient for policy (550 — see R-5321-4.1.1.3-k, which ' +
      'says so explicitly), for relaying, for anything. What it MUST NOT do is ' +
      'fail to parse it — so the assertion is narrow: 501 (or 500) convicts, ' +
      'and 550/553/554 do not. Getting this wrong in either direction is easy, ' +
      'and a test that expects 250 here will fail almost every server on the ' +
      'internet while citing a MUST, which is the worst kind of false ' +
      'positive. ' +
      'Quoted without the "but SHOULD strip off..." continuation, which is ' +
      'R-5321-4.1.1.3-c: different level, different testability.',
  },
  {
    id: 'R-5321-4.1.1.3-c',
    section: '4.1.1.3',
    page: 35,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'but SHOULD strip off the source route specification and utilize the ' +
      'domain name associated with the mailbox as if the source route had not ' +
      'been provided.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts unrouted — e.g. user@local.example — ' +
        'so that RCPT TO:<@relay.example:user@local.example> can be compared ' +
        'against RCPT TO:<user@local.example>. Both must draw the same class ' +
        'of reply if the source route was stripped.',
    },
    note:
      'Half-observable, in the R-5321-2.4-h sense. The stripping itself shows ' +
      'only in the relayed envelope, which we cannot see; what IS observable ' +
      'is the consequence — that the final mailbox, not the routing host, ' +
      'decides the reply. Hence the differential fixture: the same mailbox with ' +
      'and without a route prefix should be judged the same way. ' +
      'TRAP: SHOULD, so a server that instead rejects the source-routed form is ' +
      'taking `permitted-latitude` — indeed R-5321-4.1.1.3-k grants that ' +
      'outright with a 550. Nearly every modern server does exactly this. ' +
      'Expect `permitted-latitude` universally and do not let the report ' +
      'colour it red.',
  },
  {
    id: 'R-5321-4.1.1.3-d',
    section: '4.1.1.3',
    page: 35,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Similarly, relay hosts SHOULD strip or ignore source routes,',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns what a relay emits on its onward connection, which is ' +
        'visible only to the next hop. Compounding it, nothing on the wire ' +
        'declares a server to be a relay rather than a delivery system, so we ' +
        'could not establish that the requirement applies (cf. ' +
        'R-5321-2.3.10-b).',
    },
    note:
      '"strip or ignore" is a two-option SHOULD, so even with an outbound sink ' +
      'neither branch could be failed.',
  },
  {
    id: 'R-5321-4.1.1.3-e',
    section: '4.1.1.3',
    page: 35,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'and names MUST NOT be copied into the reverse-path.',
    testability: {
      kind: 'not-testable',
      reason:
        'The reverse-path a relay emits onward is not visible from the client ' +
        'side. Needs a receiving sink and an end-to-end path — a different ' +
        'tool (cf. R-5321-2.4-d).',
    },
    note:
      'Split from R-5321-4.1.1.3-d despite sharing a sentence: MUST NOT versus ' +
      'SHOULD is too large a gap to merge. ' +
      'Obscurely worded — "names" means the source-route hosts stripped from ' +
      'the forward-path, and the prohibition is against the RFC 821 habit of ' +
      'reversing them into the return path. Quoted verbatim rather than ' +
      'clarified; the reading belongs here in the note.',
  },
  {
    id: 'R-5321-4.1.1.3-f',
    section: '4.1.1.3',
    page: 35,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When mail reaches its ultimate destination (the forward-path contains ' +
      'only a destination mailbox), the SMTP server inserts it into the ' +
      'destination mailbox in accordance with its host mail conventions.',
    testability: {
      kind: 'not-testable',
      reason:
        'Delivery into a mailbox is the one thing SMTP never reports to the ' +
        'client — a 250 to end-of-data promises responsibility ' +
        '(R-5321-4.1.1.4-p), not that the message landed. Observing this needs ' +
        'access to the destination store, which is out of band.',
    },
    note:
      'DERIVED, hence `prose`: stated as fact with the force of MUST. ' +
      '"in accordance with its host mail conventions" would gut any test even ' +
      'if we could see the mailbox — it defers the entire behaviour to local ' +
      'policy.',
  },
  {
    id: 'R-5321-4.1.1.3-g',
    section: '4.1.1.3',
    page: 35,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'This command appends its forward-path argument to the forward-path buffer;',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts, so the forward-path buffer becomes ' +
        'non-empty and DATA flips from 503 to 354. Testing that RCPT APPENDS ' +
        'rather than REPLACES needs two acceptable recipients plus sight of ' +
        'the delivered message — a receiving sink we do not have.',
    },
    note:
      'DERIVED, hence `prose`. Partially observable, and the split matters: ' +
      'that the buffer became non-empty is visible in-band (DATA answers 354 ' +
      'instead of 503), but that a second RCPT was APPENDED rather than ' +
      'overwriting the first is visible only at delivery. A test citing this ' +
      'covers the first half only and should say so. ' +
      'Quoted with its trailing semicolon because the clause after it ' +
      '(R-5321-4.1.1.3-h) is a separate requirement with different ' +
      'testability — cf. R-5321-2.4-p.',
  },
  {
    id: 'R-5321-4.1.1.3-h',
    section: '4.1.1.3',
    page: 35,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text: 'it does not change the reverse-path buffer nor the mail data buffer.',
    testability: {
      kind: 'not-testable',
      reason:
        'A prohibition on touching internal state. There is no reply, code, or ' +
        'timing difference that distinguishes a server which left the ' +
        'reverse-path buffer alone from one that rewrote it — only the ' +
        'delivered message would show it.',
    },
    note:
      'DERIVED, hence `prose`; registered at MUST NOT because "does not ' +
      'change" is a prohibition stated as description. ' +
      'Kept precisely because it looks testable and is not — the same category ' +
      'as R-5321-2.4-o.',
  },
  {
    id: 'R-5321-4.1.1.3-i',
    section: '4.1.1.3',
    page: 35,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'As provided in Appendix C, xyz.com MAY also choose to relay the message ' +
      'to hosta.int, using the envelope commands',
    testability: {
      kind: 'not-testable',
      reason:
        'Onward relaying choice, visible only at the next hop, and a ' +
        'permission with no failing branch. The named hosts are the RFC\'s ' +
        'worked example, not real state we could arrange.',
    },
    note:
      'A genuine 2119 MAY, printed inside a worked example — which is why the ' +
      'contract says read every line rather than grep for keywords in ' +
      'paragraphs that look normative. Registered for completeness; it is ' +
      'about as far from testable as this range gets.',
  },
  {
    id: 'R-5321-4.1.1.3-j',
    section: '4.1.1.3',
    page: 36,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'prose',
    text: 'Attempting to use relaying this way is now strongly discouraged.',
    testability: {
      kind: 'not-testable',
      reason:
        'Discourages a sending practice (source-routed relaying). No receiver ' +
        'behaviour is specified, and "strongly discouraged" names no act to ' +
        'observe.',
    },
    note:
      'DERIVED, hence `prose`: "strongly discouraged" is lower case and ' +
      'therefore outside §1.3\'s 2119 scope, but it carries SHOULD NOT force. ' +
      'Same treatment as R-5321-3.5-* for "strongly recommended".',
  },
  {
    id: 'R-5321-4.1.1.3-k',
    section: '4.1.1.3',
    page: 36,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Since hosts are not required to relay mail at all, xyz.com MAY also ' +
      'reject the message entirely when the RCPT command is received, using a ' +
      '550 code (since this is a "policy reason").',
    testability: { kind: 'wire' },
    note:
      'Permission, so unfailable — but the BEHAVIOUR is worth recording in the ' +
      'matrix, because it is the escape hatch that makes R-5321-4.1.1.3-c ' +
      'nearly unfailable in practice, and a report that shows how many servers ' +
      'take it is more interesting than the SHOULD it swallows. Outcome will ' +
      'be `permitted-latitude` (task #9). ' +
      'Also embeds the prose premise "hosts are not required to relay mail at ' +
      'all", which is not registered separately: it grants nothing beyond what ' +
      'this MAY already grants, and §2.3.10/§3.6 are where relaying policy ' +
      'properly lives. ' +
      'TRAP: "using a 550 code" is illustrative of the policy class, not a ' +
      'mandated code — the sentence is a MAY throughout. A server rejecting ' +
      'with 553 or 554 has taken the same latitude by a different door.',
  },
  {
    id: 'R-5321-4.1.1.3-l',
    section: '4.1.1.3',
    page: 36,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The client MUST NOT transmit parameters other than those associated ' +
      'with a service extension offered by the server in its EHLO response.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. The corpus violates it deliberately to see what the ' +
        'server does; the reply owed for an unrecognised Rcpt-parameter is ' +
        '§4.1.1.11\'s (555/501), not this sentence\'s.',
    },
    note:
      'Note how narrow the licence is: parameters must be tied to an extension ' +
      'the server offered IN ITS EHLO RESPONSE. Out-of-band knowledge that a ' +
      'server supports an extension does not qualify. Our client must therefore ' +
      'parse the EHLO response before sending any Rcpt-parameter, or it is the ' +
      'one in violation.',
  },
  {
    id: 'R-5321-4.1.1.3-m',
    section: '4.1.1.3',
    page: 36,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Note that, in a departure from the usual rules for local-parts, the ' +
      '"Postmaster" string shown above is treated as case-insensitive.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A domain the server accepts mail for, so that RCPT ' +
        'TO:<Postmaster@that.domain> and RCPT TO:<pOsTmAsTeR@that.domain> can ' +
        'be compared. §4.5.1 makes postmaster a required mailbox, so both must ' +
        'draw the same acceptance.',
    },
    note:
      'DERIVED, hence `prose`: "is treated as case-insensitive" states a rule ' +
      'as fact, and it is the receiver that does the treating. It sits in a ' +
      'syntax note under the ABNF, which is exactly the sort of place a ' +
      'keyword-grep misses. ' +
      'This is a genuine, testable carve-out from R-5321-2.4-c (local-parts ' +
      'MUST BE case sensitive) — and it is testable in a way -2.4-c is not, ' +
      'because §4.5.1 independently requires postmaster to exist, which ' +
      'removes the "maybe both mailboxes are valid" ambiguity that defeats the ' +
      'general case. ' +
      'TRAP: the exemption covers the "Postmaster" string, not every ' +
      'local-part; do not generalise. TRAP 2: the ABNF admits both ' +
      '"<Postmaster@" Domain ">" and bare "<Postmaster>" — the bare form is a ' +
      'different requirement (§4.5.1) and a server may treat the two very ' +
      'differently. Test the domain-qualified form for this entry.',
  },

  // ---------------------------------------------------------------------------
  // 4.1.1.4  DATA (DATA)
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-4.1.1.4-a',
    section: '4.1.1.4',
    page: 36,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The receiver normally sends a 354 response to DATA, and then treats the ' +
      'lines (strings ending in <CRLF> sequences, as described in ' +
      'Section 2.3.7) following the command as mail data from the sender.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A completed MAIL plus at least one accepted RCPT, so that DATA is ' +
        'issued in a state where 354 is the expected answer. With an empty ' +
        'forward-path buffer the correct answer is 503 and the requirement ' +
        'does not apply.',
    },
    note:
      'DERIVED, hence `prose`, and registered at SHOULD rather than MUST ' +
      'because of "normally" — the RFC declines to make 354 unconditional ' +
      'here. ' +
      'TRAP: a naive test asserts "DATA -> 354" and fails a server that ' +
      'replies 503 (no recipients), 552 (message too large, known in advance ' +
      'via SIZE), 452, or 554. All are conformant. The assertion is only ' +
      'meaningful once the fixture has established a transaction that ought to ' +
      'proceed, and even then "normally" makes a 4yz `permitted-latitude`. ' +
      'The second half — treating following lines as mail data — is the DATA ' +
      'state transition itself, and is really tested via the terminator ' +
      'entries (R-5321-4.1.1.4-e, -i, -j).',
  },
  {
    id: 'R-5321-4.1.1.4-b',
    section: '4.1.1.4',
    page: 36,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'This command causes the mail data to be appended to the mail data buffer.',
    testability: {
      kind: 'not-testable',
      reason:
        'Buffer contents are internal. That data accumulated at all is ' +
        'implied by a 250 to end-of-data, but WHAT accumulated is visible only ' +
        'in the delivered message — a receiving sink we do not have (cf. ' +
        'R-5321-2.4-d).',
    },
    note:
      'DERIVED, hence `prose`. The model-versus-behaviour line drawn at ' +
      'R-5321-4.1.1-c applies: unlike MAIL\'s clearing (R-5321-4.1.1.2-d), ' +
      'this one has no in-band consequence, so it stays not-testable.',
  },
  {
    id: 'R-5321-4.1.1.4-c',
    section: '4.1.1.4',
    page: 36,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'The mail data may contain any of the 128 ASCII character codes',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction the server would otherwise accept (valid MAIL, accepted ' +
        'RCPT), carrying a body that exercises the awkward codes — NUL, DEL, ' +
        'and the C0 controls — so that a rejection can be attributed to the ' +
        'octets rather than to policy.',
    },
    note:
      'Lower-case "may", hence `prose`. Registered at MUST and against the ' +
      'SERVER because the permission is only meaningful as a receiver ' +
      'obligation: mail data containing, say, a NUL is conformant data, so a ' +
      'receiver that rejects it for that reason alone is refusing something ' +
      'the spec permits. ' +
      'TRAP, and it is a trap that will bite: "any of the 128 ASCII character ' +
      'codes" includes CR and LF, which cannot appear raw — §2.3.7 line ' +
      'structure and §4.5.2 transparency govern those, and a test that sends a ' +
      'bare CR to prove this requirement is testing the opposite of ' +
      'R-5321-4.1.1.4-i. Restrict the probe to codes with no framing meaning. ' +
      'TRAP 2: NUL in particular is rejected by plenty of respected servers, ' +
      'and the very next clause (R-5321-4.1.1.4-d) says control characters ' +
      'SHOULD be avoided — the RFC permits the data and discourages sending ' +
      'it in the same breath. Expect failures here that are really the ' +
      'industry declining a permission, and weigh the report accordingly.',
  },
  {
    id: 'R-5321-4.1.1.4-d',
    section: '4.1.1.4',
    page: 36,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'although experience has indicated that use of control characters other ' +
      'than SP, HT, CR, and LF may cause problems and SHOULD be avoided when ' +
      'possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'Advice to whoever composes the mail data. "when possible" defeats any ' +
        'assertion even in principle, and no receiver behaviour is specified.',
    },
    note:
      'Sits in direct tension with R-5321-4.1.1.4-c, which it qualifies: the ' +
      'data MAY contain the codes, but SHOULD NOT in practice. Our corpus ' +
      'takes the -c side deliberately in order to probe receivers; that is a ' +
      'considered violation of this SHOULD, not an oversight.',
  },
  {
    id: 'R-5321-4.1.1.4-e',
    section: '4.1.1.4',
    page: 36,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The mail data are terminated by a line containing only a period, that ' +
      'is, the character sequence "<CRLF>.<CRLF>", where the first <CRLF> is ' +
      'actually the terminator of the previous line (see Section 4.5.2). This ' +
      'is the end of mail data indication.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction the server accepts far enough to reach 354, so that ' +
        'sending <CRLF>.<CRLF> produces an observable completion reply rather ' +
        'than a state error.',
    },
    note:
      'DERIVED, hence `prose`: a definition, but the one that makes the whole ' +
      'protocol terminate, and a receiver that fails to recognise ' +
      '<CRLF>.<CRLF> is not implementing SMTP. Registered so the terminator ' +
      'has a citable home; R-5321-4.1.1.4-i and -j are the negative cases ' +
      'derived from it. ' +
      'Note "where the first <CRLF> is actually the terminator of the previous ' +
      'line" — this is why a client must not send an extra CRLF before the dot ' +
      '(R-5321-4.1.1.4-g), and it is the detail that most hand-rolled SMTP ' +
      'clients get wrong.',
  },
  {
    id: 'R-5321-4.1.1.4-f',
    section: '4.1.1.4',
    page: 36,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'prose',
    text:
      'the "no mail data" case does not conform to this specification since it ' +
      'would require that neither the trace header fields required by this ' +
      'specification nor the message header section required by RFC 5322 [4] ' +
      'be transmitted',
    testability: {
      kind: 'not-testable',
      reason:
        'Declares a client-composed message non-conforming. Nothing is said ' +
        'about what a receiver owes an empty message, so there is no server ' +
        'behaviour to assert — a server may accept or reject it freely.',
    },
    note:
      'DERIVED, hence `prose`, and one of the clearest examples in the RFC of ' +
      'the pattern EXTRACTING names: "does not conform to this specification" ' +
      'is a MUST NOT with the keyword filed off. It is printed inside a ' +
      'parenthetical inside a subordinate clause, which is exactly why the ' +
      'contract says read every line. ' +
      'TRAP: this makes "DATA followed immediately by ." a violation BY OUR ' +
      'CLIENT, not by the server. It is still a valuable probe — it is a ' +
      'classic parser edge — but a test sending it must not report the ' +
      'server\'s answer as conformance either way, because the RFC gives the ' +
      'server no rule to follow here.',
  },
  {
    id: 'R-5321-4.1.1.4-g',
    section: '4.1.1.4',
    page: 36,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'An extra <CRLF> MUST NOT be added, as that would cause an empty line to ' +
      'be added to the message.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client, and the effect — a spurious empty line — is ' +
        'visible only in the delivered message. A server cannot distinguish an ' +
        'intentional trailing blank line from an added one.',
    },
    note:
      'A correctness requirement on OUR client that no test will ever catch us ' +
      'breaking. The bug it describes is one of the most common in home-grown ' +
      'SMTP senders: writing body + CRLF + CRLF + "." + CRLF instead of ' +
      'reusing the body\'s own final CRLF as the first of the terminator ' +
      '(R-5321-4.1.1.4-e). Worth a unit test on the client, not a conformance ' +
      'test on the server.',
  },
  {
    id: 'R-5321-4.1.1.4-h',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'in that case, the originating SMTP system MUST either reject the ' +
      'message as invalid or add <CRLF> in order to have the receiving SMTP ' +
      'server recognize the "end of data" condition.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the originating system, and offers it two branches, so neither ' +
        'could be failed even from the sending side. The triggering condition ' +
        '— a body handed to the sender with a final line lacking <CRLF> — ' +
        'exists above SMTP entirely.',
    },
    note:
      'The exception carved out of R-5321-4.1.1.4-g: adding the CRLF the body ' +
      'lacked is not "an extra <CRLF>". ' +
      'Applies only to the ORIGINATING system — a relay is not licensed by ' +
      'this sentence to repair bodies, which matters given §2.4\'s injunction ' +
      'against relays inspecting content (R-5321-2.4-i).',
  },
  {
    id: 'R-5321-4.1.1.4-i',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The custom of accepting lines ending only in <LF>, as a concession to ' +
      'non-conforming behavior on the part of some UNIX systems, has proven to ' +
      'cause more interoperability problems than it solves, and SMTP server ' +
      'systems MUST NOT do this, even in the name of improved robustness.',
    testability: { kind: 'wire' },
    note:
      'Quoted whole because "MUST NOT do this" is meaningless without its ' +
      'antecedent, and a truncated quote would be the register lying by ' +
      'omission. ' +
      'High-value: this is the postmaster-smuggling family (CVE-2023-51764 and ' +
      'relatives), where a server\'s liberality about <LF> lets an attacker ' +
      'inject a second message past a filtering front end. Sibling of ' +
      'R-5321-2.3.8-a. ' +
      'TRAP: the RFC anticipates the counter-argument and forecloses it — ' +
      '"even in the name of improved robustness" means Postel\'s law is NOT a ' +
      'defence here. Any server that accepts bare-LF-terminated lines fails ' +
      'this, and the report should not soften it on interoperability grounds. ' +
      'TRAP 2: this covers COMMAND lines and data lines both; the narrower ' +
      'end-of-data case is R-5321-4.1.1.4-j. Testing only "<LF>.<LF>" leaves ' +
      'this entry half-covered.',
  },
  {
    id: 'R-5321-4.1.1.4-j',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In particular, the sequence "<LF>.<LF>" (bare line feeds, without ' +
      'carriage returns) MUST NOT be treated as equivalent to <CRLF>.<CRLF> as ' +
      'the end of mail data indication.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction accepted through to 354, so that <LF>.<LF> can be sent ' +
        'mid-data and the server\'s reading of it observed — followed by a ' +
        'real <CRLF>.<CRLF>, since a conformant server will still be in DATA ' +
        'state and the connection must be driven to a conclusion either way.',
    },
    note:
      'The single most valuable test in this range, and the trickiest to ' +
      'write. The assertion is observational, not a reply code: send data, ' +
      'then <LF>.<LF>, then more data, then a proper <CRLF>.<CRLF>. A ' +
      'conformant server stays in DATA state throughout and emits exactly ONE ' +
      'completion reply. A violating server emits a reply at the <LF>.<LF> and ' +
      'then treats the trailing data as commands — which is the smuggling ' +
      'primitive itself. ' +
      'TRAP: needs a timing bound to distinguish "no reply yet" from "no reply ' +
      'ever", so it depends on the expectation model carrying timeouts ' +
      '(task #9) — the same dependency as R-5321-2.4-f. ' +
      'TRAP 2: do NOT assert the server rejects the bare-LF sequence. The ' +
      'requirement is that it not be treated as the terminator; treating it as ' +
      'ordinary data is fully conformant, and so is dropping the connection. ' +
      'A test expecting a 5yz here would fail servers that are right.',
  },
  {
    id: 'R-5321-4.1.1.4-k',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Receipt of the end of mail data indication requires the server to ' +
      'process the stored mail transaction information.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction the server accepts through 354 and a terminating ' +
        '<CRLF>.<CRLF>, so that a reply — of any class — is owed.',
    },
    note:
      'DERIVED, hence `prose`: "requires the server to" is a MUST in plain ' +
      'words. ' +
      'What is observable is that SOMETHING is owed after the dot, which is ' +
      'the assertion R-5321-4.1.1.4-m and -n sharpen into OK-or-failure. This ' +
      'entry on its own is close to a tautology on the wire; kept because the ' +
      'obligation is printed and because "process" is what forbids the server ' +
      'from sitting silent after the terminator.',
  },
  {
    id: 'R-5321-4.1.1.4-l',
    deliberatelyUncovered: {
      reason:
        'needs a completed transaction then a second DATA against an empty forward-path buffer, requiring a recipient the server accepts, which is server-side state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This processing consumes the information in the reverse-path buffer, ' +
      'the forward-path buffer, and the mail data buffer, and on the ' +
      'completion of this command these buffers are cleared.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts, so a full transaction can be ' +
        'completed and a second attempted on the same connection: after the ' +
        'dot, an immediate DATA must draw 503, because the forward-path buffer ' +
        'is empty and no MAIL is in progress.',
    },
    note:
      'DERIVED, hence `prose`. The in-band consequence is real and worth ' +
      'testing — servers that leave a transaction half-alive after the dot ' +
      'produce duplicate deliveries. ' +
      'TRAP: see R-5321-4.1.1.2-d — that entry\'s test and this one\'s ' +
      'overlap, and neither can attribute a pass to one mechanism alone. Also ' +
      'note the expected 503 for post-dot DATA is owed by §4.1.4\'s sequencing ' +
      'rules; this entry supplies the reason, not the code.',
  },
  {
    id: 'R-5321-4.1.1.4-m',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the processing is successful, the receiver MUST send an OK reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts and a message it has no policy reason ' +
        'to refuse — small, plain-ASCII, well-formed RFC 5322 headers — so ' +
        'that "processing is successful" can be assumed rather than hoped.',
    },
    note:
      'TRAP, and it is a bad one: the antecedent is unobservable. We cannot ' +
      'know whether processing succeeded, so we cannot know whether the MUST ' +
      'fired. A 550 after the dot does not violate this — it means processing ' +
      'failed, which is R-5321-4.1.1.4-n\'s branch. The fixture exists purely ' +
      'to make success the overwhelmingly likely reading of a non-answer. ' +
      'TRAP 2: "an OK reply" is a class, not "250 OK". §4.2 defines the ' +
      '2yz category; asserting the literal string, or even the literal 250 ' +
      'over a 250 with different text, would be wrong.',
  },
  {
    id: 'R-5321-4.1.1.4-n',
    deliberatelyUncovered: {
      reason:
        'needs a transaction the server accepts to 354 then refuses at the dot (over-SIZE or over-quota), which is server-side failure state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the processing fails, the receiver MUST send a failure reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction the server will accept to 354 but refuse at the dot — ' +
        'e.g. a body exceeding the advertised SIZE, or a recipient over quota. ' +
        'Both need server-side state arranged out of band (task #12).',
    },
    note:
      'Split from R-5321-4.1.1.4-m: same sentence pair, opposite antecedents, ' +
      'and radically different fixtures — provoking a deterministic post-dot ' +
      'FAILURE is far harder than provoking a success. ' +
      'TRAP: "a failure reply" spans 4yz and 5yz both (§4.2.1), so a 451 is as ' +
      'conformant as a 554 and a test must not insist on permanence. ' +
      'The real defect this guards against is silence or a dropped connection ' +
      'at the dot — which is common under load and is a violation, since the ' +
      'sender is then left unable to distinguish accepted from lost and must ' +
      'retry, duplicating the message.',
  },
  {
    id: 'R-5321-4.1.1.4-o',
    deliberatelyUncovered: {
      reason:
        'needs two accepted recipients on one transaction with exactly one failing at delivery time, and the partial-failure model needs server-side state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The SMTP model does not allow for partial failures at this point: ' +
      'either the message is accepted by the server for delivery and a ' +
      'positive response is returned or it is not accepted and a failure reply ' +
      'is returned.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Two accepted recipients on one transaction, exactly one of which will ' +
        'fail at delivery time (e.g. one over quota) — so that a server ' +
        'tempted to report a partial outcome has the opportunity to. Requires ' +
        'server-side state we cannot create in-band (task #12).',
    },
    note:
      'DERIVED, hence `prose`: "does not allow" is a MUST NOT stated as a fact ' +
      'about the model, and the sentence then spells out the only two ' +
      'permitted outcomes. ' +
      'The requirement that actually bites: ONE reply to the dot, covering ALL ' +
      'recipients. A server that accepted three RCPTs and then reports success ' +
      'for two of them at the dot has violated this — and the consequence is ' +
      'severe, because a sender receiving a failure will retry the whole ' +
      'message and duplicate it for the recipients that succeeded. ' +
      'TRAP: the multiline reply syntax makes a partial report LOOK possible ' +
      '("250-user1 ok" / "550 user2 failed"), and §4.2 permits multiline ' +
      'replies generally. The reply code is what counts: one code, one verdict. ' +
      'A test should assert exactly one reply arrives and that it carries a ' +
      'single code, not that it is one line. ' +
      'TRAP 2: this is why per-recipient failure must be reported at RCPT time ' +
      'or by bounce (R-5321-4.1.1.4-q), never at the dot.',
  },
  {
    id: 'R-5321-4.1.1.4-p',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'In sending a positive "250 OK" completion reply to the end of data ' +
      'indication, the receiver takes full responsibility for the message (see ' +
      'Section 6.1).',
    testability: {
      kind: 'not-testable',
      reason:
        'Taking responsibility is an operational commitment, not a wire event. ' +
        'There is nothing to observe at the moment it is taken, and its ' +
        'breach — a message silently dropped after a 250 — is visible only to ' +
        'the intended recipient, over an interval no test can bound.',
    },
    note:
      'DERIVED, hence `prose`. Kept because it looks momentous and is ' +
      'untestable — the same category as R-5321-2.4-o, though for a different ' +
      'reason: -2.4-o has no corresponding act at all, whereas this one has an ' +
      'act we simply cannot see. ' +
      'It is the load-bearing sentence of SMTP reliability. The register should ' +
      'record plainly that this suite cannot check the single promise the ' +
      'protocol most depends on: silent discard after 250 is the most damaging ' +
      'violation in RFC 5321 and the most thoroughly invisible one. Every ' +
      'downstream requirement about bounces (R-5321-4.1.1.4-q, §4.4) exists to ' +
      'discharge THIS obligation.',
  },
  {
    id: 'R-5321-4.1.1.4-q',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Errors that are diagnosed subsequently MUST be reported in a mail ' +
      'message, as discussed in Section 4.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'The report is a new message sent to the reverse-path over a separate ' +
        'connection at an unbounded later time. Observing it needs a receiving ' +
        'sink at an address we control plus an indefinite wait — out of band ' +
        'for a suite that reasons about one connection.',
    },
    note:
      'The enforcement arm of R-5321-4.1.1.4-p: having taken responsibility at ' +
      'the dot, the server may not then fail silently. ' +
      'Would become testable if the harness ever grew an inbound sink and the ' +
      'expectation model learned to span connections. Worth revisiting then — ' +
      'a server that 250s and neither delivers nor bounces is a real and ' +
      'reportable defect, and this is the requirement it violates. Until then, ' +
      'honestly uncovered.',
  },
  {
    id: 'R-5321-4.1.1.4-r',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When the SMTP server accepts a message either for relaying or for final ' +
      'delivery, it inserts a trace record (also referred to interchangeably ' +
      'as a "time stamp line" or "Received" line) at the top of the mail data.',
    testability: {
      kind: 'not-testable',
      reason:
        'The trace record is added to the message, and the message is not ' +
        'echoed back — only the destination store or the next hop would show ' +
        'it. Needs a receiving sink and an end-to-end path (cf. ' +
        'R-5321-2.4-d).',
    },
    note:
      'DERIVED, hence `prose`: stated as what the server does, with the force ' +
      'of MUST — §4.4 confirms it, and a relay that omits Received lines ' +
      'defeats loop detection outright. ' +
      'Note "at the top": position is normative, and it is what makes the ' +
      'trace a reverse-chronological path. A server that appends would ' +
      'violate this, invisibly to us.',
  },
  {
    id: 'R-5321-4.1.1.4-s',
    section: '4.1.1.4',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This trace record indicates the identity of the host that sent the ' +
      'message, the identity of the host that received the message (and is ' +
      'inserting this time stamp), and the date and time the message was ' +
      'received.',
    testability: {
      kind: 'not-testable',
      reason:
        'Specifies the contents of a header we never see, for the reason given ' +
        'in R-5321-4.1.1.4-r. Unobservable from the client side.',
    },
    note:
      'DERIVED, hence `prose`. Registered separately from R-5321-4.1.1.4-r ' +
      'because that one obliges the server to insert a record and this one ' +
      'says what must be in it — an implementation could satisfy the first and ' +
      'fail this by stamping a Received line with no From clause, which is a ' +
      'real and observed behaviour in privacy-minded submission servers. ' +
      'Detailed syntax is §4.4\'s, not this section\'s; the two remaining ' +
      'sentences of the paragraph ("Relayed messages will have multiple time ' +
      'stamp lines" and the pointer to §4.4) are descriptive and are not ' +
      'registered.',
  },
] as const satisfies readonly RequirementDef[];
