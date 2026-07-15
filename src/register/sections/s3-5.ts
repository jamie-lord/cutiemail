/**
 * RFC 5321 §3.5 — Commands for Debugging Addresses
 *
 * Covers §3.5.1 (Overview), §3.5.2 (VRFY Normal Response), §3.5.3 (Meaning of
 * VRFY or EXPN Success Response) and §3.5.4 (Semantics and Applications of EXPN).
 * §3.5 itself is a bare heading with no normative text of its own.
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * The section-wide trap: this is the most self-contradictory corner of RFC 5321.
 * §3.5.1 and §3.5.2 say implementations SHOULD support VRFY and EXPN; §3.5.2
 * then permits disabling them outright for security reasons; §3.5.3 says a
 * syntax-only check MUST NOT get 250 and SHOULD get 500/502, then in the very
 * next sentence says returning 500/502 for VRFY is "not in full compliance".
 * §7.3 sides with the operators. In practice almost every deployed MTA answers
 * VRFY with 252 or 502 and does not implement EXPN at all. A test author who
 * reads any one of these sentences in isolation will write a test that fails
 * every well-run server on the Internet. Assert the narrow MUST NOTs; record
 * the SHOULDs as latitude.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_5 = [
  // ---------------------------------------------------------------------------
  // 3.5.1  Overview
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-3.5.1-a',
    section: '3.5.1',
    page: 22,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Implementations SHOULD support VRFY and EXPN (however, see Section 3.5.2 ' +
      'and Section 7.3).',
    testability: { kind: 'wire' },
    note:
      'Observable: send VRFY and EXPN and see whether they are implemented. But ' +
      'the parenthetical is the whole story — §3.5.2 permits disabling both "for ' +
      'security reasons" and §7.3 discusses why operators do. So this SHOULD is ' +
      'pre-emptively excused by its own sentence. Expect `permitted-latitude` on ' +
      'essentially every real server; record which posture was taken (implemented ' +
      '/ 252 / 502 / 550) rather than pass-fail. Duplicated almost verbatim as ' +
      'R-5321-3.5.2-g and reinforced as R-5321-3.5.3-d; kept separate because the ' +
      'RFC states it three times in three sections and the register is denominated ' +
      'in RFC sentences, not in distinct ideas.',
  },
  {
    id: 'R-5321-3.5.1-b',
    section: '3.5.1',
    page: 22,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a normal (i.e., 250) response is returned, the response MAY include the ' +
      'full name of the user',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A user name that VRFY resolves to with a 250 reply, on a server that ' +
        'has not disabled VRFY. Requires server-side state — see task #12.',
    },
    note:
      'Permission, so unfailable. Quoted only as far as the MAY clause; the MUST ' +
      'that follows in the same sentence is R-5321-3.5.1-c.',
  },
  {
    id: 'R-5321-3.5.1-c',
    section: '3.5.1',
    page: 22,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'MUST include the mailbox of the user.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A user name that VRFY resolves to with a 250 reply, on a server that ' +
        'has not disabled VRFY. Requires server-side state — see task #12.',
    },
    note:
      'The testable half of the sentence split at R-5321-3.5.1-b. Only bites on a ' +
      '250 — a 252/502/550 reply says nothing about this requirement, so the test ' +
      'must be conditional on actually obtaining a 250 and report `inapplicable` ' +
      'otherwise. Overlaps R-5321-3.5.2-a, which is the stronger statement ' +
      '(fully-qualified domain, angle brackets); assert the strict form there.',
  },
  {
    id: 'R-5321-3.5.1-d',
    section: '3.5.1',
    page: 22,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'It MUST be in either of the following forms:',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A VRFY that yields a 250 reply, so the reply text can be parsed against ' +
        'the two forms "User Name <local-part@domain>" and "local-part@domain".',
    },
    note:
      'The two forms are given as an indented figure immediately below and are ' +
      'therefore not part of the quotable sentence; they are ' +
      '"User Name <local-part@domain>" and "local-part@domain". Short quote, but ' +
      'unique in the document — the figure that follows is what makes it so. ' +
      'Note the second form has NO angle brackets, while R-5321-3.5.2-a says the ' +
      'reply MUST use a "<local-part@domain>" construction and R-5321-3.5.2-c ' +
      'says addresses SHOULD appear in pointed brackets. A test that requires ' +
      'brackets fails a server obeying the bare second form here. Assert the ' +
      'union, not the intersection.',
  },
  {
    id: 'R-5321-3.5.1-e',
    section: '3.5.1',
    page: 23,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When a name that is the argument to VRFY could identify more than one ' +
      'mailbox, the server MAY either note the ambiguity or identify the ' +
      'alternatives.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A user name matching two or more mailboxes on the server, plus VRFY ' +
        'enabled and actually verifying.',
    },
    note:
      'Permission with two named options, so unfailable either way. The three ' +
      '553 examples that follow in the RFC are illustrative, not normative — the ' +
      'text says "any of the following are legitimate responses", which is a ' +
      'licence, not a constraint. Do not test for the literal string "User ' +
      'ambiguous"; the RFC only says using the given forms "will facilitate ' +
      'automated translation", which is not normative either.',
  },
  {
    id: 'R-5321-3.5.1-f',
    section: '3.5.1',
    page: 23,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'For the EXPN command, the string identifies a mailing list, and the ' +
      'successful (i.e., 250) multiline response MAY include the full name of the ' +
      'users',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list that EXPN expands with a 250 multiline reply, on a server ' +
        'with EXPN enabled. Rare in the wild — see task #12.',
    },
    note:
      'Permission. Quoted only as far as the MAY clause; the MUST in the same ' +
      'sentence is R-5321-3.5.1-g.',
  },
  {
    id: 'R-5321-3.5.1-g',
    section: '3.5.1',
    page: 23,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'MUST give the mailboxes on the mailing list.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list with known members that EXPN expands with a 250 multiline ' +
        'reply. Needs both EXPN enabled and a list whose membership we know.',
    },
    note:
      'Conditional on a 250: EXPN is disabled on most servers, so this will read ' +
      '`inapplicable` far more often than it reads pass. Pairs with ' +
      'R-5321-3.5.1-k (one mailbox per reply line).',
  },
  {
    id: 'R-5321-3.5.1-h',
    section: '3.5.1',
    page: 23,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a request is made to apply VRFY to a mailing list, a positive response ' +
      'MAY be given if a message so addressed would be delivered to everyone on ' +
      'the list',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list address, VRFY enabled, and knowledge of whether mail to ' +
        'that address reaches every member.',
    },
    note:
      'Permission, and its precondition ("would be delivered to everyone on the ' +
      'list") is server-internal — we cannot tell from the socket whether a ' +
      'server that answered 250 was entitled to. Only the negative branch ' +
      '(R-5321-3.5.1-i) has any assertable content, and it is a SHOULD.',
  },
  {
    id: 'R-5321-3.5.1-i',
    section: '3.5.1',
    page: 23,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'otherwise an error SHOULD be reported (e.g., "550 That is a mailing list, ' +
      'not a user" or "252 Unable to verify members of mailing list").',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list that does NOT deliver to every member (or that the server ' +
        'declines to treat as a user), plus VRFY enabled.',
    },
    note:
      'Note the RFC\'s own examples span 550 and 252 — two different reply ' +
      'classes for the same "error". So assert "not 2yz except 252", not a code. ' +
      'A test that demands 5yz here fails a server following the second printed ' +
      'example. The example texts are illustrative ("e.g."); never match on them.',
  },
  {
    id: 'R-5321-3.5.1-j',
    section: '3.5.1',
    page: 23,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a request is made to expand a user name, the server MAY return a ' +
      'positive response consisting of a list containing one name, or an error ' +
      'MAY be reported (e.g., "550 That is a user name, not a mailing list").',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A plain user mailbox (not a list) EXPNed on a server with EXPN enabled.',
    },
    note:
      'Two MAYs in one sentence, but they are the two arms of a single free ' +
      'choice, so splitting them would create two entries neither of which could ' +
      'ever be failed independently. Kept whole. Text spans the page 23/24 ' +
      'boundary in spec/rfc5321.txt; quoted continuously, and paged to 23 where ' +
      'it starts.',
  },
  {
    id: 'R-5321-3.5.1-k',
    section: '3.5.1',
    page: 24,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'In the case of a successful multiline reply (normal for EXPN), exactly one ' +
      'mailbox is to be specified on each line of the reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list with two or more known members, expanded by EXPN with a ' +
        '250 multiline reply.',
    },
    note:
      'DERIVED, hence `prose`: "is to be specified" is a bare imperative with no ' +
      'RFC 2119 keyword, but it is a flat constraint on reply formatting with no ' +
      'hedge, and the EXPN example in the same section obeys it line for line. ' +
      'Read as MUST. Testable in principle by counting addresses per reply line, ' +
      'and worth it — a server packing two mailboxes onto one line breaks every ' +
      'naive EXPN parser.',
  },
  {
    id: 'R-5321-3.5.1-l',
    section: '3.5.1',
    page: 24,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An implementation of the VRFY or EXPN commands MUST include at least ' +
      'recognition of local mailboxes as "user names".',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A known-valid local mailbox on the server under test, plus VRFY or EXPN ' +
        'actually implemented.',
    },
    note:
      'Only binds a server that implements the command at all — a server that ' +
      'returns 502 is not violating this, because it has no "implementation of ' +
      'the VRFY or EXPN commands" to speak of. "recognition" is weaker than ' +
      'verification: a 252 arguably recognises the name without verifying it, so ' +
      'do not require 250. The failure this can honestly catch is a server that ' +
      'verifies "local-part@domain" but rejects the bare local-part outright as a ' +
      'syntax error.',
  },
  {
    id: 'R-5321-3.5.1-m',
    section: '3.5.1',
    page: 24,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'hosts, especially hosts that provide this functionality, SHOULD accept the ' +
      '"local-part@domain" form as a "user name";',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A known-valid mailbox expressed as local-part@domain, on a server with ' +
        'VRFY implemented.',
    },
    note:
      'Quoted from mid-sentence ("hosts, especially...") because the preceding ' +
      'clause is rationale about multi-domain hosting, not obligation. Trailing ' +
      'semicolon kept: the clause after it is R-5321-3.5.1-n. "accept ... as a ' +
      'user name" means parse it as a name, not necessarily verify it — a 252 is ' +
      'acceptance. Failing on anything but 250 would be a false positive.',
  },
  {
    id: 'R-5321-3.5.1-n',
    section: '3.5.1',
    page: 24,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'hosts MAY also choose to recognize other strings as "user names".',
    testability: {
      kind: 'not-testable',
      reason:
        'Open-ended permission to recognise unspecified additional string forms. ' +
        'There is no enumerable set of "other strings" to probe and no outcome ' +
        'that could falsify it — anything the server accepts or rejects is ' +
        'consistent with the permission.',
    },
  },
  {
    id: 'R-5321-3.5.1-o',
    section: '3.5.1',
    page: 24,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'the response SHOULD be interpreted very carefully, if at all, and SHOULD ' +
      'generally only be used for diagnostic purposes.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the consumer of the reply, and constrains how it reasons about ' +
        'what it received. Interpreting something carefully produces no wire ' +
        'event. Two SHOULDs, kept as one entry: they bind the same party with ' +
        'the same (nil) testability, so splitting adds a row and no information.',
    },
    note:
      'Advice to us, in fact: this suite is exactly a "diagnostic purpose", and ' +
      'this sentence is the RFC warning that VRFY/EXPN reply text is historically ' +
      'so variable that strict parsing is unwise. Let it temper how hard we ' +
      'assert R-5321-3.5.1-c/-d and R-5321-3.5.2-a. ' +
      'The neighbouring sentence "The character string arguments of the VRFY and ' +
      'EXPN commands cannot be further restricted due to the variety of ' +
      'implementations" is deliberately NOT registered: it explains why the spec ' +
      'declines to constrain the argument grammar, which is drafting rationale, ' +
      'not a conformance obligation on either party.',
  },

  // ---------------------------------------------------------------------------
  // 3.5.2  VRFY Normal Response
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-3.5.2-a',
    section: '3.5.2',
    page: 24,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When normal (2yz or 551) responses are returned from a VRFY or EXPN ' +
      'request, the reply MUST include the <Mailbox> name using a ' +
      '"<local-part@domain>" construction, where "domain" is a fully-qualified ' +
      'domain name.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A VRFY or EXPN yielding a 2yz or 551 reply — i.e. a known-valid (or ' +
        'known-forwarded) address on a server with the command implemented.',
    },
    note:
      'The strongest testable MUST in §3.5. Two traps. First, "2yz" includes ' +
      '252 — and a 252 ("cannot VRFY user, but will accept message") is by ' +
      'construction a reply that has NOT identified a mailbox, so demanding an ' +
      'address in every 2yz would fail almost every real server. Read the ' +
      'requirement as binding replies that actually return an address, which is ' +
      'how R-5321-3.5.2-d frames the same idea; scope the test to 250/251/551. ' +
      'Second, it conflicts with the bracket-less second form permitted by ' +
      'R-5321-3.5.1-d. "fully-" / "qualified" is a hyphenated line break in the ' +
      'source; quoted rejoined as the test normaliser requires.',
  },
  {
    id: 'R-5321-3.5.2-b',
    section: '3.5.2',
    page: 24,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In circumstances exceptional enough to justify violating the intent of ' +
      'this specification, free-form text MAY be returned.',
    testability: {
      kind: 'not-testable',
      reason:
        'A blanket escape hatch whose trigger ("circumstances exceptional enough ' +
        'to justify violating the intent of this specification") is a judgement ' +
        'made inside the server. No observation can establish that the ' +
        'circumstances were or were not exceptional, so nothing can be failed.',
    },
    note:
      'Registered because it materially weakens R-5321-3.5.2-a: any server ' +
      'failing that MUST can claim this. Worth remembering before we report a ' +
      'VRFY reply-format failure as a hard defect.',
  },
  {
    id: 'R-5321-3.5.2-c',
    section: '3.5.2',
    page: 24,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In order to facilitate parsing by both computers and people, addresses ' +
      'SHOULD appear in pointed brackets.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A VRFY or EXPN reply that actually contains an address (250/251/551).',
    },
    note:
      'Text spans the page 24/25 boundary in spec/rfc5321.txt; paged to 24 where ' +
      'it starts. SHOULD, so a bare "local-part@domain" reply — explicitly one of ' +
      'the two legal forms under R-5321-3.5.1-d — is `permitted-latitude`, not a ' +
      'failure. "pointed brackets" means angle brackets; do not go looking for ' +
      'some other character.',
  },
  {
    id: 'R-5321-3.5.2-d',
    section: '3.5.2',
    page: 25,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When addresses, rather than free-form debugging information, are returned, ' +
      'EXPN and VRFY MUST return only valid domain addresses that are usable in ' +
      'SMTP RCPT commands.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A VRFY/EXPN reply containing an address, plus the ability to feed that ' +
        'address back into a RCPT TO on a fresh connection and see it accepted.',
    },
    note:
      'Genuinely round-trippable, and a good test: parse the address out of the ' +
      'VRFY reply, then RCPT TO it. But beware — "usable in SMTP RCPT commands" ' +
      'is about the address being a valid domain address, not about the server ' +
      'being obliged to accept mail for it right now. A 550 for policy reasons ' +
      '(quota, greylisting, sender rejection) does not falsify this; only a ' +
      'syntax rejection (5x1) does. Distinguishing those requires reading the ' +
      'reply class carefully and will still misfire on servers that answer 550 ' +
      'for everything.',
  },
  {
    id: 'R-5321-3.5.2-e',
    section: '3.5.2',
    page: 25,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Consequently, if an address implies delivery to a program or other system, ' +
      'the mailbox name used to reach that target MUST be given.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An alias on the server that delivers to a program or pipe (a |command ' +
        'alias, or a file delivery), plus VRFY implemented and verifying it.',
    },
    note:
      'Needs a deliberately exotic fixture — a pipe/program alias — that most ' +
      'modern MTAs do not configure by default and that task #12 would have to ' +
      'create on purpose. Realistically out of reach for third-party targets; ' +
      'only assertable against a server we control.',
  },
  {
    id: 'R-5321-3.5.2-f',
    section: '3.5.2',
    page: 25,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Paths (explicit source routes) MUST NOT be returned by VRFY or EXPN.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A VRFY or EXPN reply containing an address, on a server with the command ' +
        'implemented.',
    },
    note:
      'Cheap once we have any address-bearing reply: assert the returned address ' +
      'contains no "@host," source-route prefix (the @ONE,@TWO:joe@three form of ' +
      '§4.1.2 / Appendix C). Never fires on a modern server, but it is a clean, ' +
      'unhedged MUST NOT with no latitude anywhere in the section — one of the ' +
      'few here that can be reported as a real failure without qualification.',
  },
  {
    id: 'R-5321-3.5.2-g',
    section: '3.5.2',
    page: 25,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Server implementations SHOULD support both VRFY and EXPN.',
    testability: { kind: 'wire' },
    note:
      'Restates R-5321-3.5.1-a, and is immediately undercut by R-5321-3.5.2-h in ' +
      'the next sentence. Registered separately because it is a separate RFC ' +
      'sentence with a different scope ("both"). Expect `permitted-latitude` ' +
      'everywhere; EXPN in particular is close to extinct in the wild.',
  },
  {
    id: 'R-5321-3.5.2-h',
    section: '3.5.2',
    page: 25,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'For security reasons, implementations MAY provide local installations a ' +
      'way to disable either or both of these commands through configuration ' +
      'options or the equivalent (see Section 7.3).',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission about what CONFIGURABILITY the implementation offers its ' +
        'operator, not about behaviour on the wire. A server with VRFY disabled ' +
        'proves nothing — it may have no config knob at all and simply not ' +
        'implement it. The knob is invisible from a socket.',
    },
    note:
      'The most consequential entry in §3.5 despite being untestable: it is the ' +
      'licence every operator exercises, and it is why R-5321-3.5.1-a, ' +
      'R-5321-3.5.2-g and R-5321-3.5.3-e must never be reported as failures.',
  },
  {
    id: 'R-5321-3.5.2-i',
    section: '3.5.2',
    page: 25,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When these commands are supported, they are not required to work across ' +
      'relays when relaying is supported.',
    testability: {
      kind: 'not-testable',
      reason:
        'A relief from obligation rather than an obligation: it says a server ' +
        'need not verify addresses it would only relay. Nothing a server does ' +
        'can violate a permission not to do something, so there is no failing ' +
        'observation.',
    },
    note:
      'DERIVED, hence `prose`: "are not required to" carries the force of a MAY ' +
      '(the server may decline) with no keyword. Levelled MAY accordingly. This ' +
      'is the sentence that makes 252 the honest answer for a relay target, and ' +
      'it interacts with R-5321-3.5.3-f, which says 252 SHOULD be used in exactly ' +
      'these cases.',
  },
  {
    id: 'R-5321-3.5.2-j',
    section: '3.5.2',
    page: 25,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'if EXPN is supported, it MUST be listed as a service extension in an EHLO ' +
      'response.',
    testability: { kind: 'wire' },
    note:
      'The best test in §3.5: no fixture, no ambiguity. Send EHLO, then EXPN. If ' +
      'EXPN is supported (i.e. does not answer 502/500) but "EXPN" was absent ' +
      'from the EHLO keyword list, that is a clean failure. The converse — EXPN ' +
      'advertised but unsupported — is not covered by this sentence. ' +
      'Historical oddity worth knowing: EXPN was never actually registered as an ' +
      'SMTP service extension with IANA, so a server obeying this literally is ' +
      'advertising a keyword that no extension registry defines. Some servers ' +
      'therefore support EXPN without advertising it; the RFC nonetheless says ' +
      'MUST, and the register records the MUST.',
  },
  {
    id: 'R-5321-3.5.2-k',
    section: '3.5.2',
    page: 25,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'VRFY MAY be listed as a convenience',
    testability: { kind: 'wire' },
    note:
      'Permission, so unfailable, but trivially observable in the EHLO keyword ' +
      'list — worth recording as a behaviour in the matrix alongside ' +
      'R-5321-3.5.2-j. Note the asymmetry the RFC draws: EXPN MUST be advertised ' +
      'if supported, VRFY MAY be. Quoted without trailing punctuation because the ' +
      'sentence continues into R-5321-3.5.2-l, which binds the client.',
  },
  {
    id: 'R-5321-3.5.2-l',
    section: '3.5.2',
    page: 25,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'since support for it is required, SMTP clients are not required to check ' +
      'for its presence on the extension list before using it.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and grants it a relief (no obligation to check the ' +
        'extension list). A server cannot observe whether the client checked, ' +
        'and neither can we.',
    },
    note:
      'DERIVED, hence `prose`: "are not required to" with no keyword, force of a ' +
      'MAY. Note the flat contradiction it rests on — "support for it is ' +
      'required" (from RFC 1123) directly against R-5321-3.5.2-g\'s SHOULD and ' +
      'R-5321-3.5.2-h\'s licence to disable VRFY entirely. The RFC does not ' +
      'reconcile these; we record all three and reconcile nothing. ' +
      'Practical consequence for our client: it is entitled to send VRFY without ' +
      'first seeing it advertised, which is what the R-5321-3.5.2-j test needs to ' +
      'do anyway.',
  },

  // ---------------------------------------------------------------------------
  // 3.5.3  Meaning of VRFY or EXPN Success Response
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-3.5.3-a',
    section: '3.5.3',
    page: 25,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A server MUST NOT return a 250 code in response to a VRFY or EXPN command ' +
      'unless it has actually verified the address.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An address that is syntactically valid but certainly NOT deliverable on ' +
        'the target (a random local-part at the server\'s own domain), plus VRFY ' +
        'implemented.',
    },
    note:
      'Testable in the negative direction only, and even then by inference: a ' +
      '250 for an address we are confident does not exist implies the server did ' +
      'not verify. "Actually verified" is an internal fact, so we can never ' +
      'confirm compliance, only catch the blatant case. Requires real confidence ' +
      'that the probe address is invalid — a catch-all domain makes the test ' +
      'meaningless and must be detected first (probe two distinct random ' +
      'local-parts). See R-5321-3.5.3-b, the sharper special case.',
  },
  {
    id: 'R-5321-3.5.3-b',
    section: '3.5.3',
    page: 25,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In particular, a server MUST NOT return 250 if all it has done is to ' +
      'verify that the syntax given is valid.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Two distinct syntactically-valid, certainly-nonexistent local-parts at ' +
        'the server\'s domain, to distinguish a syntax-only 250 from a catch-all.',
    },
    note:
      'A special case of R-5321-3.5.3-a, registered separately because the RFC ' +
      'states it separately and because it is the one that catches a real, common ' +
      'defect: servers that answer 250 to VRFY of anything well-formed. The ' +
      'discrimination test is that a syntax-only implementation 250s literally ' +
      'every well-formed address — but so does a catch-all domain, and the two ' +
      'are indistinguishable from a socket. Honest conclusion: this can produce ' +
      'a strong suspicion, not a proof, and the report must say so.',
  },
  {
    id: 'R-5321-3.5.3-c',
    section: '3.5.3',
    page: 25,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In that case, 502 (Command not implemented) or 500 (Syntax error, command ' +
      'unrecognized) SHOULD be returned.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server that performs only syntax checking on VRFY — the antecedent of ' +
        '"In that case". We cannot establish this state; we can only guess at it ' +
        'from R-5321-3.5.3-b\'s inference.',
    },
    note:
      'Read the antecedent carefully: "In that case" means "if all the server can ' +
      'do is syntax checking". This is NOT a general instruction to answer 500/502 ' +
      'to VRFY. And it is immediately contradicted by R-5321-3.5.3-e, which says ' +
      'servers returning 500/502 for VRFY "are not in full compliance". So the RFC ' +
      'tells a syntax-only server to return 502 and then calls returning 502 ' +
      'non-compliant. There is no test that respects both sentences; the honest ' +
      'move is to record the reply code and fail neither.',
  },
  {
    id: 'R-5321-3.5.3-d',
    section: '3.5.3',
    page: 25,
    level: 'RECOMMENDED',
    party: 'server',
    normativeSource: 'prose',
    text:
      'As stated elsewhere, implementation (in the sense of actually validating ' +
      'addresses and returning information) of VRFY and EXPN are strongly ' +
      'recommended.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "strongly recommended" is lower case, so it is not ' +
      'an RFC 2119 keyword occurrence — but RFC 2119 defines RECOMMENDED as ' +
      'synonymous with SHOULD and this sentence exists solely to restate the ' +
      'obligation of R-5321-3.5.1-a with added force. Levelled RECOMMENDED. Note ' +
      'it raises the bar over R-5321-3.5.1-a: not merely "support", but "actually ' +
      'validating addresses and returning information" — which rules out 252 as ' +
      'satisfying it. Still fully excused by R-5321-3.5.2-h. Latitude, not failure.',
  },
  {
    id: 'R-5321-3.5.3-e',
    section: '3.5.3',
    page: 25,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Hence, implementations that return 500 or 502 for VRFY are not in full ' +
      'compliance with this specification.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: no keyword, but "not in full compliance with this ' +
      'specification" names the behaviour a violation outright — the same ' +
      'construction §2.4 uses for uppercase-only verbs, and the register treats it ' +
      'the same way. Levelled MUST on that reading. ' +
      'THE TRAP OF THIS SECTION. Trivially observable — send VRFY, check for ' +
      '500/502 — and it will fire on a large share of well-run production ' +
      'servers, because R-5321-3.5.2-h explicitly permits disabling VRFY and §7.3 ' +
      'recommends considering it. The RFC contradicts itself within four ' +
      'sentences (see R-5321-3.5.3-c). Note the hedge "not in FULL compliance", ' +
      'which is softer than a violation and reads as the authors knowing they had ' +
      'lost this argument to operational reality. Record the observation; do not ' +
      'report it as a defect. A strong candidate for `deliberatelyUncovered` if ' +
      'we decide the noise outweighs the signal — but that decision is not this ' +
      'task\'s to make.',
  },
  {
    id: 'R-5321-3.5.3-f',
    section: '3.5.3',
    page: 25,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'In these situations, reply code 252 SHOULD be returned.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An address at a domain the server acts as a mail exchanger for but ' +
        'cannot verify in real time — i.e. a backup-MX or relay-target domain ' +
        'configured on the server under test. See task #12.',
    },
    note:
      '"These situations" = an address of apparent validity that cannot ' +
      'reasonably be verified in real time, typically at a backup MX. Establishing ' +
      'that state from outside is the hard part: we would have to know the ' +
      'server\'s relay configuration. Without the fixture, a 252 tells us nothing ' +
      '— it is also the standard reply of a server that simply refuses to verify ' +
      'anything, which R-5321-3.5.2-h permits.',
  },
  {
    id: 'R-5321-3.5.3-g',
    section: '3.5.3',
    page: 25,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Implementations generally SHOULD be more aggressive about address ' +
      'verification in the case of VRFY than in the case of RCPT, even if it ' +
      'takes a little longer to do so.',
    testability: {
      kind: 'not-testable',
      reason:
        'Comparative and unquantified — "more aggressive ... than" has no wire ' +
        'form. We could observe that VRFY 252s while RCPT 250s, but that is not ' +
        'the same measurement: RCPT acceptance is not evidence of verification ' +
        'depth, and the SHOULD is hedged with "generally" on top. There is no ' +
        'observation that establishes relative aggressiveness.',
    },
    note:
      'Registered because it looks superficially testable (compare VRFY and RCPT ' +
      'outcomes for the same address) and is not: the two commands differ in ' +
      'purpose, and a server may legitimately 252 VRFY while 250-ing RCPT under ' +
      'R-5321-3.5.2-h. Any test built on that comparison would be measuring ' +
      'policy, not aggressiveness.',
  },

  // ---------------------------------------------------------------------------
  // 3.5.4  Semantics and Applications of EXPN
  // ---------------------------------------------------------------------------
  {
    id: 'R-5321-3.5.4-a',
    section: '3.5.4',
    page: 26,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'has made it nearly impossible for these strategies to work consistently, ' +
      'and mail systems SHOULD NOT attempt them.',
    testability: {
      kind: 'not-testable',
      reason:
        'The prohibited behaviour is "source expansion of mailing lists as a ' +
        'means of eliminating duplicates" — a sending-side optimisation performed ' +
        'before or during submission. Nothing a receiving server does on the wire ' +
        'reveals whether it expands lists at source to deduplicate, and this ' +
        'suite never plays the receiver.',
    },
    note:
      'Quoted from mid-sentence, and with the preceding clause attached for ' +
      'uniqueness: "and mail systems SHOULD NOT attempt them." alone is a ' +
      'dangling referent and a fragile quote. "them" = the duplicate-elimination ' +
      'strategies named two sentences earlier. ' +
      'The rest of §3.5.4 is history and rationale (EXPN\'s usefulness in ' +
      'debugging, why aliasing broke source expansion) with no further ' +
      'obligations — this SHOULD NOT is the section\'s only normative sentence. ' +
      'Party is `client` in the sense that matters: the actor is whoever is ' +
      'originating/submitting, which our suite is, and our client must not do it.',
  },
] as const satisfies readonly RequirementDef[];
