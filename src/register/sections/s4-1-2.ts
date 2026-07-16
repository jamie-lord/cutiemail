/**
 * RFC 5321 §4.1.2 — Command Argument Syntax
 * RFC 5321 §4.1.3 — Address Literals
 *
 * Verbatim quotes from spec/rfc5321.txt (lines 2250-2442). Do not paraphrase:
 * the register's `every requirement quotes RFC 5321 verbatim` test checks every
 * `text` field against the vendored RFC and will fail on drift.
 *
 * Note on where these requirements live: most of the section is ABNF, and some of
 * its strongest obligations are written inside ABNF comments rather than in prose
 * — "MUST BE accepted, SHOULD NOT be generated, and SHOULD be ignored" for source
 * routes is a semicolon comment hanging off the A-d-l production, not a paragraph.
 * They are registered here exactly as if they were body text, because they are
 * normatively indistinguishable from it. An extractor who reads only the prose
 * paragraphs of §4.1.2 will miss four requirements.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_1_2 = [
  {
    id: 'R-5321-4.1.2-a',
    section: '4.1.2',
    page: 41,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'the so-called "source ; route", MUST BE accepted,',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server is known to accept, sent once bare and once with ' +
        'an "@hop:" route prefix, so a rejection of the routed form can be pinned ' +
        'to the route syntax rather than to the mailbox. "postmaster" (guaranteed ' +
        'acceptable by §4.5.1) is the in-band candidate; otherwise a fixture ' +
        'mailbox per task #12.',
    },
    note:
      'One sentence in the A-d-l ABNF comment carries three requirements binding ' +
      'two parties with three different testabilities; split into -a, -b, -c. ' +
      'Quoted as a fragment, with the preceding words for uniqueness — the split ' +
      'points overlap deliberately (cf. R-5321-2.4-p/q). ' +
      'The stray "; " inside the quote ("source ; route") is real: this is an ABNF ' +
      'comment, and the "; " that begins its continuation line survives the test ' +
      'normaliser\'s whitespace collapse, so verbatim matching requires it. Same ' +
      'artifact in -b, -c, -d, and both 4.1.3 comment quotes. ' +
      '"MUST BE" (two words, capitalised) is the RFC\'s own formatting, as in §2.4. ' +
      'TRAP: "accepted" here means *parsed without a syntax error*, not *relayed ' +
      'along the route*. Appendix C is explicit that a server may ignore the route ' +
      'entirely (that is -c). So the assertion is narrow: send ' +
      '"RCPT TO:<@hop.example:user@dest.example>" and require that the reply is ' +
      'not a 500/501 syntax rejection. A 550 for an unknown recipient still passes ' +
      'this requirement — the mailbox being bad is "another reason for rejection". ' +
      'Distinguishing "rejected the source-route syntax" from "rejected the ' +
      'mailbox" is the whole difficulty of testing this; the test must compare ' +
      'against the same mailbox sent without a route prefix, and only fail when ' +
      'the bare form is accepted and the routed form draws a 5xy syntax error. ' +
      'Widely violated in practice — Postfix and Exim reject source routes by ' +
      'default — which makes it a high-value observation, not a reason to soften it.',
  },
  {
    id: 'R-5321-4.1.2-b',
    section: '4.1.2',
    page: 41,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: 'MUST BE accepted, SHOULD NOT be ; generated,',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the generating client. Our own client deliberately takes the ' +
        'contrary option in order to observe the server half (R-5321-4.1.2-a), ' +
        'exactly as the corpus does for R-5321-2.4-g.',
    },
    note:
      'Quoted with the preceding clause because "SHOULD NOT be generated," alone ' +
      'is a fragile quote. Note the tension our suite lives in: we must generate ' +
      'source routes to test -a, while -b tells clients not to. That is fine — the ' +
      'suite is a probe, not a conforming MTA — but it should be said out loud.',
  },
  {
    id: 'R-5321-4.1.2-c',
    section: '4.1.2',
    page: 41,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SHOULD NOT be ; generated, and SHOULD be ignored.',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether the receiver ignored the route or honoured it is visible only in ' +
        'where the message goes next — the next hop\'s envelope or the delivered ' +
        'copy — never in the reply codes we can see from the client side. Revisit ' +
        'if task #12 grows an outbound sink.',
    },
    note:
      'Looks testable, is not. A server that accepts the routed RCPT (-a) tells us ' +
      'nothing about whether it then ignored the "@hop:" prefix or tried to relay ' +
      'via it — both produce the same 250. This is the §2.4-d family of problem: ' +
      'the requirement lands downstream of everything we can observe.',
  },
  {
    id: 'R-5321-4.1.2-d',
    section: '4.1.2',
    page: 41,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If this string is an email address, ; i.e., a Mailbox, then the "xtext" ' +
      'syntax [32] ; SHOULD be used.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the party constructing an esmtp-value, i.e. the client. No server ' +
        'obligation is stated to reject a non-xtext address-valued parameter, so ' +
        'there is nothing on the wire that distinguishes compliance from ' +
        'permitted latitude.',
    },
    note:
      'Reference marker "[32]" is quoted as printed (it is RFC 3461, the DSN ' +
      'spec). This is the esmtp-value ABNF comment, not body prose. In practice ' +
      'the requirement only bites for extensions whose parameter values are ' +
      'mailboxes — ORCPT being the canonical one — so it belongs to the extension ' +
      'corpus (task #19) if anywhere.',
  },
  {
    id: 'R-5321-4.1.2-e',
    section: '4.1.2',
    page: 42,
    level: 'MAY',
    party: 'both',
    normativeSource: 'keyword',
    text: 'MAY be case-sensitive',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission attached to the Local-part production. Permissions are ' +
        'unfailable by construction, and the obligation it implies for receivers ' +
        'is already registered as R-5321-2.4-c, which is the testable form.',
    },
    note:
      'Short quote — two words plus a keyword — but "MAY be case-sensitive" as an ' +
      'exact string occurs only in this ABNF comment (verified against the ' +
      'vendored text). ' +
      'TRAP for the reader, not the test: this MAY appears to weaken §2.4\'s ' +
      '"The local-part of a mailbox MUST BE treated as case sensitive." It does ' +
      'not. §2.4 binds the *transport* to preserve and not fold case; this comment ' +
      'says the *mailbox owner* may choose to make distinctions the transport ' +
      'must then carry. A test author who reads this as licence to skip ' +
      'R-5321-2.4-c has misread it.',
  },
  {
    id: 'R-5321-4.1.2-f',
    section: '4.1.2',
    page: 42,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'While the above definition for Local-part is relatively permissive, for ' +
      'maximum interoperability, a host that expects to receive mail SHOULD avoid ' +
      'defining mailboxes where the Local-part requires (or uses) the ' +
      'Quoted-string form or where the Local-part is case-sensitive.',
    testability: {
      kind: 'not-testable',
      reason:
        'A constraint on how an operator provisions mailboxes, not on any ' +
        'protocol behaviour. We cannot enumerate a server\'s mailboxes from a ' +
        'socket, and even if we could, "avoid defining" is a fact about the ' +
        'configuration rather than about anything the server says.',
    },
    note:
      'Registered because it is a real SHOULD, and dropping it would flatter the ' +
      'denominator. Note "case-sensitive" is hyphenated across a line break in ' +
      'spec/rfc5321.txt; the test normaliser rejoins it, so it is quoted naturally.',
  },
  {
    id: 'R-5321-4.1.2-g',
    section: '4.1.2',
    page: 42,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'For any purposes that require generating or comparing Local-parts (e.g., ' +
      'to specific mailbox names), all quoted forms MUST be treated as ' +
      'equivalent,',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A single known-valid mailbox that can be addressed three ways: bare ' +
        '(user@d), redundantly quoted ("user"@d), and quoted with a gratuitous ' +
        'backslash ("us\\er"@d). Requires a recipient the server accepts, which ' +
        'is server-side state we cannot create in-band — see task #12.',
    },
    note:
      'Quoted with its trailing comma: the clause after it (R-5321-4.1.2-h) binds ' +
      'the other party at a different level, so the sentence is split there. ' +
      'This is the sharpest testable requirement in §4.1.2 and a well-known source ' +
      'of divergence. "Treated as equivalent" means <"user"@d> and <user@d> must ' +
      'reach the same mailbox — so a server that 250s the bare form and 550s the ' +
      'quoted form is in violation, and many are. ' +
      'TRAP: a 550 on BOTH forms proves nothing (the mailbox may simply not ' +
      'exist), and a 250 on both proves little either, since a promiscuous server ' +
      'that accepts every recipient passes trivially. The assertion only has force ' +
      'against a fixture mailbox known to be valid, and only compares the two ' +
      'replies to each other. Do not assert an exact code — 250 vs 251 is latitude ' +
      'under §3.3.',
  },
  {
    id: 'R-5321-4.1.2-h',
    section: '4.1.2',
    page: 42,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'and the sending system SHOULD transmit the form that uses the minimum ' +
      'quoting possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending system. Our client must violate it on purpose — ' +
        'transmitting deliberately over-quoted forms is the only way to probe ' +
        'R-5321-4.1.2-g.',
    },
  },
  {
    id: 'R-5321-4.1.2-i',
    section: '4.1.2',
    page: 42,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Systems MUST NOT define mailboxes in such a way as to require the use in ' +
      'SMTP of non-ASCII characters (octets with the high order bit set to one) ' +
      'or ASCII "control characters" (decimal value 0-31 and 127).',
    testability: {
      kind: 'not-testable',
      reason:
        'About how mailboxes are *defined* — a provisioning fact, invisible from ' +
        'a socket, exactly like R-5321-4.1.2-f. The wire-visible half of the same ' +
        'paragraph is R-5321-4.1.2-j.',
    },
    note:
      'Text starts on page 42 and runs across the 42/43 break; quoted continuously ' +
      'and filed under the page it starts on, per EXTRACTING. ' +
      '"high order" is unhyphenated here, unlike §2.4\'s "high-order" — quoted as ' +
      'printed in each place.',
  },
  {
    id: 'R-5321-4.1.2-j',
    section: '4.1.2',
    page: 43,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'These characters MUST NOT be used in MAIL or RCPT commands or other ' +
      'commands that require mailbox names.',
    testability: { kind: 'wire' },
    note:
      'The wire-testable counterpart to -i, and it overlaps §2.4\'s ' +
      '"Receiving systems SHOULD reject such commands" (R-5321-2.4-l) — but note ' +
      'the levels differ. §2.4 says receivers SHOULD reject 8-bit envelope ' +
      'commands; here the prohibition is a flat MUST NOT on *use*, and §4.1.2\'s ' +
      'closing paragraph (R-5321-4.1.2-n) supplies the receiver\'s duty to reject ' +
      'with 501. Read together they are stronger than either alone. ' +
      'Worth testing the control-character half specifically, which §2.4 does not ' +
      'cover: a bare NUL, or a raw CR inside a local-part, in RCPT TO. Those are ' +
      'smuggling primitives, and a server that swallows them is interesting ' +
      'regardless of the reply code. ' +
      'TRAP: SMTPUTF8 (RFC 6531) legitimately lifts the non-ASCII half once ' +
      'negotiated, so the test must run before EHLO advertises it or must not ' +
      'negotiate it.',
  },
  {
    id: 'R-5321-4.1.2-k',
    section: '4.1.2',
    page: 43,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Note that the backslash, "\\", is a quote character, which is used to ' +
      'indicate that the next character is to be used literally (instead of its ' +
      'normal interpretation).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A valid mailbox whose local-part contains a character that is ' +
        'significant unquoted (e.g. a comma or an "@"), addressable as ' +
        '<"Joe\\,Smith"@d>. Needs a server-side mailbox we cannot create in-band ' +
        '— see task #12.',
    },
    note:
      'DERIVED, hence `prose`: written as a gloss on the quoted-pairSMTP ' +
      'production ("Note that...") with no keyword, but it is the only place the ' +
      'RFC states the *semantics* of the backslash. The ABNF gives the shape ' +
      '(%d92 %d32-126) and this sentence gives the meaning; a receiver that ' +
      'parses <"Joe\\,Smith"@d> as two addresses is not conforming to anything ' +
      'else in the document, so the force is here or nowhere. Registered at MUST ' +
      'on that reading. A conservative extractor could reasonably file this as ' +
      'definitional and skip it — recorded so the judgement is visible rather ' +
      'than silent. ' +
      'The RFC\'s worked example is "Joe\\,Smith", a nine-character local-part; ' +
      'the comma is only the fourth character because the backslash does not ' +
      'count. Note the trailing sentence with that example is NOT quoted here — it ' +
      'illustrates rather than requires.',
  },
  {
    id: 'R-5321-4.1.2-l',
    section: '4.1.2',
    page: 43,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'characters outside the set of alphabetic characters, digits, and hyphen ' +
      'MUST NOT appear in domain name labels for SMTP clients or servers.',
    testability: { kind: 'wire' },
    note:
      'Binds both sides explicitly ("for SMTP clients or servers"), but only the ' +
      'server half is observable: send EHLO with an underscored name, or MAIL ' +
      'FROM:<u@bad_label.example>, and see what comes back. The duty to reject is ' +
      'R-5321-4.1.2-n, with its specific 501. ' +
      'TRAP, and a serious one: underscores in hostnames are endemic in the real ' +
      'world, and a great many servers accept them deliberately. This requirement ' +
      'is one of the most-violated MUSTs in 5321. Report the violation; do not ' +
      'soften the requirement to make popular servers pass. ' +
      'Second trap: the leading clause of this sentence ("To promote ' +
      'interoperability and consistent with long-standing guidance...") is ' +
      'rationale, not requirement, and is deliberately not quoted.',
    deliberatelyUncovered: {
      reason:
        'underscores and other non-alphanumeric characters in domain labels are endemic in real hostnames and a great many servers accept them deliberately; a MUST-NOT test asserting rejection would fail a large fraction of conformant-in-practice servers. The register note records the violation for a report, but the suite does not convict it.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.2-m',
    section: '4.1.2',
    page: 43,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text: 'In particular, the underscore character is not permitted.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "is not permitted" rather than "MUST NOT", the same ' +
      'construction §2.4 uses for R-5321-2.4-k, and the force is identical. ' +
      'Strictly it is a worked instance of -l rather than an independent rule, and ' +
      'a lumper would fold it in. Kept separate because it is the case that ' +
      'actually matters in practice — it is the only character the RFC felt the ' +
      'need to name — and because a distinct ID lets the report say "underscore in ' +
      'domain label" instead of "some invalid character", which is what a reader ' +
      'of the results will want to know.',
    deliberatelyUncovered: {
      reason:
        'the underscore-specific case of R-5321-4.1.2-l; same reason — endemic in practice, a test would false-positive on many real servers.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.2-n',
    section: '4.1.2',
    page: 43,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers that receive a command in which invalid character codes have ' +
      'been employed, and for which there are no other reasons for rejection, ' +
      'MUST reject that command with a 501 response (this rule, like others, ' +
      'could be overridden by appropriate SMTP extensions).',
    testability: { kind: 'wire' },
    note:
      'The most consequential requirement in §4.1.2 and the one a naive test will ' +
      'get wrong in three separate ways. ' +
      '(1) The code is EXACT. This is one of the few places 5321 names a specific ' +
      'reply rather than a class, so unlike R-5321-2.4-l (where asserting 5yz is ' +
      'the right call) the assertion here really is "501", not "5xx". A 500 or a ' +
      '550 is a genuine miss. Do not generalise it to the class out of kindness. ' +
      '(2) "no other reasons for rejection" is an escape hatch wide enough to ' +
      'drive a server through. A 550 "relay denied" or a 452 "out of resources" ' +
      'is a different reason, and the server is then free of this rule. So the ' +
      'probe must be a command that is unimpeachable except for one bad octet — ' +
      'which in practice means EHLO with an invalid character in the domain, or ' +
      'MAIL FROM with a null reverse-path plus a malformed parameter, NOT a RCPT ' +
      'to a nonexistent mailbox (the mailbox is "another reason"). ' +
      '(3) The parenthetical is normative latitude, not decoration: a server ' +
      'advertising SMTPUTF8 has "appropriate SMTP extensions" and may lawfully ' +
      'accept characters this rule forbids. Quoted with the parenthetical intact ' +
      'for exactly that reason; the test must not negotiate SMTPUTF8, and should ' +
      'record the outcome as permitted-latitude rather than failure if the server ' +
      'advertises it. ' +
      'Also note the scope: "invalid character codes" is not defined here, and ' +
      'inherits from -i/-j (non-ASCII and controls in mailbox names) and -l/-m ' +
      '(non-LDH in domain labels). Those are the character sets to probe. ' +
      'CALIBRATION WATCH-ITEM (task #23): the exact-501 assertion is the single ' +
      'place in the corpus most likely to fire against a mainstream server — some ' +
      'Postfix builds emit 500 (not 501) for a control-octet syntax error. If it ' +
      'reds a triaged-conformant Postfix/Exim, that is a divergence to RECORD (the ' +
      'server departs from the exact-501 MUST), and the open question is whether to ' +
      'weaken THIS register entry to 5yz-class — NOT evidence the test is wrong. ' +
      'Left faithful to the RFC text until a real server forces the call.',
  },

  {
    id: 'R-5321-4.1.3-a',
    section: '4.1.3',
    page: 43,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text:
      'To bypass this barrier, a special literal form of the address is allowed ' +
      'as an alternative to a domain name.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission granting the existence of a syntactic form, not a ' +
        'behaviour either party performs. Permissions cannot be failed, and no ' +
        'corresponding server obligation to accept address literals is stated ' +
        'anywhere in §4.1.3.',
    },
    note:
      'DERIVED, hence `prose`: "is allowed" has the force of MAY without the word. ' +
      'Registered mainly as a warning label. TRAP: it is tempting to read this ' +
      'section as "servers must accept [192.0.2.1] wherever a domain is legal" and ' +
      'to write a test asserting that MAIL FROM:<u@[192.0.2.1]> draws a 250. §4.1.3 ' +
      'says no such thing — it defines the syntax and grants clients its use, and ' +
      'the obligation to accept it, if it exists at all, lives in §2.3.5 and ' +
      '§4.1.1.1, not here. Refusing address literals is extremely common ' +
      'anti-abuse policy. Any test in this area must cite the requirement that ' +
      'actually binds, not this sentence.',
  },
  {
    id: 'R-5321-4.1.3-b',
    section: '4.1.3',
    page: 43,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Standardized-tag MUST be specified in a ; Standards-Track RFC and ' +
      'registered with IANA',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the IETF process, not an SMTP implementation. There is no wire ' +
        'event corresponding to a tag having been standardised; the only thing a ' +
        'socket could show is a server accepting an unregistered tag, which this ' +
        'sentence does not forbid it from doing.',
    },
    note:
      'Kept precisely because it looks actionable and is not — the §2.4-o family, ' +
      'where the sentence constrains how the spec is extended rather than how a ' +
      'server behaves. The only registered General-address-literal tag to date is ' +
      'IPv6, and that one has its own production, so this rule has arguably never ' +
      'been exercised. ' +
      'Note the RFC prints no full stop at the end of this ABNF comment; quoted ' +
      'without one.',
  },
  {
    id: 'R-5321-4.1.3-c',
    section: '4.1.3',
    page: 44,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'representing a decimal integer ; value in the range 0 through 255',
    testability: {
      kind: 'not-testable',
      reason:
        'Bounds the value of an IPv4-address-literal octet below what ABNF can ' +
        'say (1*3DIGIT also matches 256-999), so it constrains a generator. §4.1.3 ' +
        'states no receiver duty to reject an out-of-range octet, and in practice ' +
        'the platform inet_pton would catch it — a passing test would measure ' +
        'libc, not the server.',
    },
    note:
      'DERIVED, hence `prose`: no keyword, but "value in the range 0 through 255" ' +
      'excludes tokens the grammar admits ("256"), which is a bound on the valid ' +
      'set, exactly like the IPv6 group caps in -d/-e. Registered for parity with ' +
      'them so the judgement is visible rather than silent — a conservative ' +
      'extractor could equally file all three as pure grammar. Quoted with the ' +
      'ABNF "; " continuation artifact, and without a trailing period (the RFC ' +
      'prints none). ' +
      'Distinguished from Snum-neighbouring comments like \'The "::" represents at ' +
      'least 2 16-bit groups of zeros\' (registered nowhere): those explain what a ' +
      'notation denotes; this one rejects otherwise-well-formed input.',
  },
  {
    id: 'R-5321-4.1.3-d',
    section: '4.1.3',
    page: 44,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'No more than 6 groups in addition to the ; "::" may be present.',
    testability: {
      kind: 'not-testable',
      reason:
        'A constraint on the IPv6-comp grammar that ABNF cannot express, so it ' +
        'was written as a comment. Only a generator can violate it, and §4.1.3 ' +
        'places no duty on a receiver to detect or reject an over-long literal — ' +
        'so nothing observable follows from either behaviour.',
    },
    note:
      'DERIVED, hence `prose`: lowercase "may", but the sentence bounds what ' +
      'counts as a well-formed IPv6-comp, which is a MUST NOT on generators in ' +
      'substance. A conservative extractor could file this as pure grammar and ' +
      'skip it; recorded so the call is visible. ' +
      'The preceding sentence in the same comment — \'The "::" represents at least ' +
      '2 16-bit groups of zeros.\' — is deliberately NOT registered: it describes ' +
      'what the notation means rather than requiring anything of anyone. ' +
      'TRAP if someone later argues this into a test: over-long literals are ' +
      'rejected by inet_pton in every mainstream MTA as a side effect of using the ' +
      'platform parser, so a passing result would measure libc, not the server.',
  },
  {
    id: 'R-5321-4.1.3-e',
    section: '4.1.3',
    page: 44,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'No more than 4 groups in addition to the ; "::" and IPv4-address-literal ' +
      'may be present.',
    testability: {
      kind: 'not-testable',
      reason:
        'The IPv6v4-comp analogue of R-5321-4.1.3-d, and untestable for the same ' +
        'reason: it constrains generation, and no receiver obligation to enforce ' +
        'it is stated in this section.',
    },
    note:
      'DERIVED, hence `prose` — see R-5321-4.1.3-d for the reasoning, which ' +
      'applies unchanged. Registered separately because it is a distinct bound on ' +
      'a distinct production (IPv6v4-comp, not IPv6-comp); folding the two would ' +
      'lose the fact that the RFC states the limit twice with different numbers.',
  },
] as const satisfies readonly RequirementDef[];
