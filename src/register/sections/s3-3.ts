/**
 * RFC 5321 §3.3 — Mail Transactions
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Section spans spec/rfc5321.txt lines 1015-1161, pages 19-21.
 *
 * Extraction character: §3.3 is a *narrative* section — it walks MAIL/RCPT/DATA
 * in order and states most receiver obligations as plain fact ("the SMTP server
 * returns a 250 OK reply") rather than with a keyword. Nearly half the entries
 * below are therefore `prose`. It is also the section that hands servers the
 * most latitude in the whole document: relay refusal, deferred reverse-path
 * validation, post-354 policy rejection and "other circumstances and reply codes
 * are possible" are all blessed here. A test author who reads §3.3 as a list of
 * exact reply codes will fail every competent MTA on the Internet. Read the
 * notes before writing assertions.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_3 = [
  {
    id: 'R-5321-3.3-a',
    section: '3.3',
    page: 19,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In general, the MAIL command may be sent only when no mail transaction ' +
      'is in progress; see Section 4.1.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender: a restriction on when the client may emit MAIL. ' +
        'The receiver-side correlate (503 for a nested MAIL) is owned by ' +
        '§4.1.4, which this sentence explicitly defers to.',
    },
    note:
      'PROSE, not keyword: lowercase "may ... only when" is a permission ' +
      'bounded by a condition, which is a prohibition on the complement — the ' +
      'force of MUST NOT without the word. The "In general" hedge is doing ' +
      'less than it looks: the exception it anticipates is the extension case, ' +
      'not general laxity. ' +
      'Quoted without the surrounding parentheses, which are the RFC\'s (the ' +
      'whole sentence is parenthetical); the words are contiguous and unique. ' +
      'Our own client MUST obey this, since a nested MAIL would confound every ' +
      'transaction-state test downstream.',
  },
  {
    id: 'R-5321-3.3-b',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command tells the SMTP-receiver that a new mail transaction is ' +
      'starting and to reset all its state tables and buffers, including any ' +
      'recipients or mail data.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts, so that transaction 1 can leave ' +
        'recipient state behind for MAIL to be seen clearing.',
    },
    note:
      'PROSE: stated as what the command "tells" the receiver, but it is a ' +
      'receiver obligation in every practical sense — the same family as ' +
      '§2.4\'s "The receiver will take no action until this sequence is ' +
      'received", registered as R-5321-2.4-f. ' +
      'TRAP: the obvious test (MAIL, RCPT, MAIL again, DATA) does not work — ' +
      'a second MAIL inside a transaction draws 503 under §4.1.4, so the ' +
      'reset never happens and nothing is observed. The reset is only visible ' +
      'ACROSS transactions: complete transaction 1 with a valid recipient, ' +
      'then MAIL FROM and go straight to DATA. If recipients were cleared the ' +
      'server rejects (503/554, see R-5321-3.3-x); if it accepts the data, it ' +
      'carried recipients over — a serious defect and a cross-transaction ' +
      'injection primitive. ' +
      'Note the assertion is weak in one direction: R-5321-3.3-x is a MAY, so ' +
      'a server that accepts DATA with no recipients is not thereby proven to ' +
      'have failed to reset. Only a delivered message would prove that.',
    deliberatelyUncovered: {
      date: '2026-07-16',
      reason:
        'The in-band form is not soundly convictable, exactly as this note ' +
        'warns: a nested MAIL is a client MUST NOT that a conformant server may ' +
        '503 (§4.1.4-o), and a 354 to a recipient-less DATA is R-5321-3.3-x ' +
        'permitted-latitude — so DATA=354 cannot distinguish "recipient ' +
        'survived the reset" from "reset happened, server defers empty-DATA ' +
        'rejection". An in-band test was written and REMOVED for exactly this ' +
        'confound. The only sound form observes the DELIVERED message at a sink ' +
        '(a stale recipient in the delivered envelope), but that is gated on the ' +
        'server accepting the nested MAIL, which mainstream MTAs reject with ' +
        '503 — low yield. Recorded rather than built.',
    },
  },
  {
    id: 'R-5321-3.3-c',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'discussion of error reporting). If accepted, the SMTP server returns a ' +
      '"250 OK" reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture: 'A reverse-path the server under test accepts in MAIL FROM.',
    },
    note:
      'Quoted with the preceding words ("discussion of error reporting).") ' +
      'purely for uniqueness: \'If accepted, the SMTP server returns a "250 ' +
      'OK" reply.\' appears three times in §3.3 verbatim — here for MAIL, at ' +
      'the RCPT step (R-5321-3.3-h, which disambiguates itself with "and ' +
      'stores the forward-path"), and again after end-of-data. Same technique ' +
      'as R-5321-2.4-q. ' +
      'PROSE: indicative mood, but the reply code is the entire observable ' +
      'contract of MAIL. ' +
      'TRAP: assert the CODE (250), never the TEXT. "OK" is illustrative — ' +
      '§4.2 makes reply text non-normative and real servers say "250 2.1.0 ' +
      'Ok", "250 Sender ok", etc. A test matching /^250 OK$/ is a false ' +
      'positive generator. ' +
      'The fixture is softer than most: virtually every server accepts almost ' +
      'any syntactically valid reverse-path, precisely because of ' +
      'R-5321-3.3-e.',
  },
  {
    id: 'R-5321-3.3-d',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the mailbox specification is not acceptable for some reason, the ' +
      'server MUST return a reply indicating whether the failure is permanent ' +
      '(i.e., will occur again if the client tries to send the same address ' +
      'again) or temporary (i.e., the address might be accepted if the client ' +
      'tries again later).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A reverse-path the server under test rejects at MAIL time — e.g. a ' +
        'sender in a domain it blocks, or one failing its SPF/policy checks. ' +
        'Server-specific and not creatable in-band; see task #12.',
    },
    note:
      'The MUST is only about the permanent/temporary DISTINCTION, not about ' +
      'rejecting — i.e. the assertion is "if it rejects, the reply is 5yz or ' +
      '4yz and the class matches the durability of the failure". The first ' +
      'digit carries this per §4.2.1, so mechanically any 4yz/5yz satisfies ' +
      'the letter of it, and we cannot check the class is the RIGHT one ' +
      'without knowing the server\'s intent. In practice this degenerates to ' +
      '"not a 2yz/3yz". Register it, but expect a thin test. ' +
      'TRAP 1: "Normally, failures produce 550 or 553 replies." follows two ' +
      'sentences later and is NOT registered — "Normally" is descriptive, not ' +
      'normative. Do not assert 550/553; 501, 550, 553 and 554 are all seen ' +
      'in the field and all conformant here. ' +
      'TRAP 2: the RFC immediately undercuts this itself — "Despite the ' +
      'apparent scope of this requirement" — and licenses deferral via ' +
      'R-5321-3.3-e. A server that 250s a bad sender is exercising that ' +
      'latitude, not violating this.',
  },
  {
    id: 'R-5321-3.3-e',
    section: '3.3',
    page: 19,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In those cases, the server MAY reasonably accept the reverse-path ' +
      '(with a 250 reply) and then report problems after the forward-paths ' +
      'are received and examined.',
    testability: {
      kind: 'not-testable',
      reason:
        'The escape hatch from R-5321-3.3-d, and unobservable as such: a 250 ' +
        'to MAIL looks identical whether the server found the reverse-path ' +
        'acceptable or is deferring judgement to the RCPT step. Nothing on ' +
        'the wire distinguishes the two, and taking the latitude requires ' +
        'server-internal intent we cannot read.',
    },
    note:
      'Registered mainly so R-5321-3.3-d has something to point at. Its real ' +
      'effect on the suite is negative: it means a MAIL-time 250 for a bad ' +
      'sender can never be scored a failure. Any test of -d must be written ' +
      'as "reject-or-defer", i.e. unfailable at the MAIL step alone.',
  },
  {
    id: 'R-5321-3.3-f',
    section: '3.3',
    page: 19,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: 'contemporary systems SHOULD NOT use source routing (see Appendix C).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds whoever composes the reverse-path — the sending system. There ' +
        'is no receiver behaviour here; the receiver\'s side of source routes ' +
        'is R-5321-3.3-k/l/m, on the forward-path.',
    },
    note:
      'The reverse-path twin of R-5321-3.3-j (which says the same about ' +
      'forward-paths, and is the one people quote). Quoted from "contemporary" ' +
      'rather than from "Historically" to keep the entry to the operative ' +
      'clause; the historical half is background. ' +
      'Our client MUST NOT take this latitude either way — we deliberately DO ' +
      'send source routes in the forward-path to exercise R-5321-3.3-k, but ' +
      'that is a different path and a different entry.',
  },
  {
    id: 'R-5321-3.3-g',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'This step of the procedure can be repeated any number of times.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Enough distinct recipients the server accepts to show repetition — ' +
        'in practice ~100, since that is where §4.5.3.1.10 lets it stop.',
    },
    note:
      'PROSE, and a weak one — "can be repeated" is descriptive of the ' +
      'protocol shape. Registered because the receiver obligation is real: a ' +
      'server that accepts exactly one RCPT per transaction is not speaking ' +
      'SMTP. Marked MUST on that reading; flag it if you disagree. ' +
      'TRAP: "any number of times" is FALSE as written and a test that takes ' +
      'it literally is wrong. §4.5.3.1.10 sets the recipient buffer minimum at ' +
      '100, and §4.5.3.1 says larger values are the server\'s choice — so a ' +
      'server may legitimately 452 the 101st RCPT. Assert at most ~100 ' +
      'accepted, and treat 452 beyond that as conformant, not as a failure. ' +
      'Sending 1000 RCPTs and expecting 1000 x 250 would fail Postfix, Exim ' +
      'and every server worth testing.',
  },
  {
    id: 'R-5321-3.3-h',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If accepted, the SMTP server returns a "250 OK" reply and stores the ' +
      'forward-path.',
    testability: {
      kind: 'wire-with-fixture',
      fixture: 'A recipient address the server under test accepts.',
    },
    note:
      'PROSE, same reading as R-5321-3.3-c. Self-disambiguating thanks to ' +
      '"and stores the forward-path", so no borrowed prefix needed here. ' +
      'Two clauses, one testable: the 250 is on the wire; "stores the ' +
      'forward-path" is internal state, observable only indirectly (DATA later ' +
      'succeeding rather than drawing 554 "no valid recipients") and even then ' +
      'only weakly, because R-5321-3.3-x makes that rejection a MAY. ' +
      'Assert the code, not the text — see the trap on R-5321-3.3-c.',
  },
  {
    id: 'R-5321-3.3-i',
    section: '3.3',
    page: 19,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the recipient is known not to be a deliverable address, the SMTP ' +
      'server returns a 550 reply, typically with a string such as "no such ' +
      'user -" and the mailbox name (other circumstances and reply codes are ' +
      'possible).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An address in a domain the server is authoritative for, with a ' +
        'local-part that is known-invalid AND that the server actually ' +
        'verifies at RCPT time (many do not — see note).',
    },
    note:
      'Starts at "If the" on page 19 and continues onto page 20; per the ' +
      'contract it takes the page it STARTS on. ' +
      'QUOTING HAZARD: the RFC line-wraps as `"no such user -` / `" and the ' +
      'mailbox name`. The test normaliser\'s hyphen-rejoin rule (/-\\n\\s+/ -> ' +
      '"-") eats that break, so the normalised document reads `"no such user ' +
      '-" and the mailbox name` — no space before the closing quote, even ' +
      'though the printed RFC has one. The quote above matches the NORMALISED ' +
      'form, which is what the test compares against. Do not "fix" it back to ' +
      '`- "` — it will fail. ' +
      'TRAP: "(other circumstances and reply codes are possible)" is part of ' +
      'the sentence and guts it. Assert 5yz, never 550 specifically — 551, ' +
      '553 and 554 all appear in the field. ' +
      'Bigger trap: the antecedent is "known not to be a deliverable ' +
      'address". A server that does no recipient verification at RCPT time ' +
      'does not KNOW, so its 250 violates nothing (§3.3 explicitly ' +
      'acknowledges these servers later — see R-5321-3.3-aa). Combined with ' +
      'the anti-harvesting practice of 250-ing every recipient, this is close ' +
      'to unfailable against a hardened server. The honest scoring is ' +
      'reject-or-defer.',
  },
  {
    id: 'R-5321-3.3-j',
    section: '3.3',
    page: 20,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'contemporary SMTP clients SHOULD NOT utilize source routes (see ' +
      'Appendix C).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client composing the forward-path. Our corpus ' +
        'deliberately violates it in order to observe the server ' +
        '(R-5321-3.3-k/l/m) — the same posture as R-5321-2.4-g.',
    },
    note:
      'Distinct from R-5321-3.3-f: that one is the reverse-path, this one the ' +
      'forward-path. Both quotes end "(see Appendix C)." but the verbs differ ' +
      '("use" vs "utilize"), so both are unique substrings.',
  },
  {
    id: 'R-5321-3.3-k',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Servers MUST be prepared to encounter a list of source routes in the ' +
      'forward-path,',
    testability: { kind: 'wire' },
    note:
      'Quoted with its trailing comma: the clause that follows is a separate ' +
      'requirement at a different level (R-5321-3.3-l / -m). ' +
      'The most interesting MUST in the section, and the hardest to assert. ' +
      '"be prepared to encounter" is NOT "must accept" — the very next clause ' +
      'permits ignoring the routes or declining the relaying, so 250, 550 and ' +
      '551 are all conformant responses to `RCPT TO:<@a.example:u@b.example>`. ' +
      'What the MUST forbids is being UNPREPARED: dropping the connection, ' +
      'timing out, 421-ing, or crashing. Whether a 501 syntax error counts as ' +
      'unprepared is genuinely ambiguous — the path IS valid RFC 5321 grammar ' +
      '(§4.1.2 A-d-l), so a parser that cannot read it has arguably failed to ' +
      'be prepared; but a server that parses it fine and answers 501 as a ' +
      'policy refusal has not. We cannot tell those apart from a socket. ' +
      'Recommended assertion: the server MUST return a well-formed reply of ' +
      'any class and keep the session usable (a following RSET/NOOP must still ' +
      'work). Score 501 as permitted-latitude with the code recorded. This is ' +
      'a case for the four-state taxonomy (task #9).',
  },
  {
    id: 'R-5321-3.3-l',
    section: '3.3',
    page: 20,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'they SHOULD ignore the routes',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether the server ignored the routes or honoured them shows only in ' +
        'where the message goes — the next hop, or the delivered copy. From ' +
        'the client side, "ignored the routes and accepted the final mailbox" ' +
        'and "accepted the whole route" are both a 250 on RCPT. Would need a ' +
        'receiving sink and an end-to-end path, like R-5321-2.4-d.',
    },
    note:
      'Short quote, but unique in the document ("they SHOULD ignore the ' +
      'routes" occurs once). ' +
      'Note the alternative in the same sentence (R-5321-3.3-m) is a MAY, so ' +
      'even with a sink this is unfailable: a server that declines is taking ' +
      'the other branch. Pure permitted-latitude either way.',
  },
  {
    id: 'R-5321-3.3-m',
    section: '3.3',
    page: 20,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'MAY decline to support the relaying they imply.',
    testability: { kind: 'wire' },
    note:
      'The alternative branch to R-5321-3.3-l, split out because the level ' +
      'differs (SHOULD vs MAY) and only this half is observable — declining ' +
      'produces a 5yz on the wire; ignoring produces nothing distinguishable. ' +
      'Exactly the shape of R-5321-2.4-h ("MAY clear the high-order bit or ' +
      'reject"): a two-option MAY where one option is visible and one is not. ' +
      'Unfailable; record which branch was taken.',
  },
  {
    id: 'R-5321-3.3-n',
    section: '3.3',
    page: 20,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Similarly, servers MAY decline to accept mail that is destined for ' +
      'other hosts or systems.',
    testability: { kind: 'wire' },
    note:
      'This is the sentence that makes refusing to be an open relay ' +
      'conformant, and it is the single most important thing in §3.3 for ' +
      'avoiding false positives. ANY test that offers the server a ' +
      'RCPT TO in a domain it is not authoritative for must treat 550/554 ' +
      '"relay access denied" as permitted-latitude — never as a failure. ' +
      'Every internet-facing MTA built since roughly 1997 takes this ' +
      'permission, so the "declines" branch is effectively the universal ' +
      'answer and the MAY is unfailable in the other direction too. ' +
      'Useful as a PROBE rather than an assertion: the reply here tells the ' +
      'suite whether the server relays for us, which several fixtures ' +
      '(task #12) need to know before they can be set up.',
  },
  {
    id: 'R-5321-3.3-o',
    section: '3.3',
    page: 20,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'restricted-capability clients MUST NOT assume that any SMTP server on ' +
      'the Internet can be used as their mail processing (relaying) site.',
    testability: {
      kind: 'not-testable',
      reason:
        'A rule about what a client may ASSUME — a constraint on ' +
        'implementer reasoning, not a behaviour. There is no wire event ' +
        'corresponding to assuming something, and no observation could ' +
        'falsify it.',
    },
    note:
      'Kept precisely because it carries a hard MUST NOT and still cannot be ' +
      'tested — the same category as R-5321-2.4-o ("MUST NOT be construed as ' +
      'authorization"). If the register ever looks like it is padding its ' +
      'testable count, entries like this are the proof it is not. ' +
      'The RFC hyphenates across the line break ("restricted-" / ' +
      '"capability"); the normaliser rejoins, so the natural ' +
      '"restricted-capability" is the correct quote.',
  },
  {
    id: 'R-5321-3.3-p',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a RCPT command appears without a previous MAIL command, the server ' +
      'MUST return a 503 "Bad sequence of commands" response.',
    testability: { kind: 'wire' },
    note:
      'The best requirement in the section: unconditional MUST, exact code ' +
      'named, no fixture, no latitude. EHLO then RCPT TO:<anything> and ' +
      'expect 503. High-value — sequencing bugs here are the root of a whole ' +
      'class of transaction-state confusion. ' +
      'Unusually, asserting the exact 503 IS legitimate: unlike R-5321-3.3-i, ' +
      'this sentence names one code with no "typically" or "other codes are ' +
      'possible" hedge. Still assert the CODE only, never the text — "Bad ' +
      'sequence of commands" is illustrative under §4.2. ' +
      'Watch two things: (1) do not send a valid RCPT address, or a lenient ' +
      'server that reorders may confuse the result; (2) some servers answer ' +
      '503 5.5.1 with an enhanced status code prefix — that is still 503. ' +
      'Overlaps §4.1.4, which restates command ordering generally; this is ' +
      'the RCPT-specific instance and is the one to test.',
  },
  {
    id: 'R-5321-3.3-q',
    section: '3.3',
    page: 20,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'spaces are not permitted on either side of the colon following FROM in ' +
      'the MAIL command or TO in the RCPT command. The syntax is exactly as ' +
      'given above.',
    testability: { kind: 'wire' },
    note:
      'PROSE: "are not permitted" carries the force of MUST NOT without the ' +
      'word — the same construction as §2.4\'s "a sending SMTP system is not ' +
      'permitted to send envelope commands in any character set other than ' +
      'US-ASCII" (R-5321-2.4-k). "The syntax is exactly as given above" is ' +
      'quoted with it because it is what removes any wiggle room. ' +
      'Party BOTH, deliberately not split: this is one syntax prohibition, ' +
      'not two verbs. The client half (do not send the space) is untestable ' +
      'by us and our client must obey it except in the corpus case below; the ' +
      'server half is what we can see. ' +
      'BIG TRAP. This sentence says the SYNTAX is illegal; it does NOT say ' +
      'the server must reject it. No sentence in §3.3 does. Sending ' +
      '"MAIL FROM: <u@example.com>" (one space after the colon) and asserting ' +
      '501 would fail Postfix, Exim, Sendmail and Exchange — all of which ' +
      'tolerate it deliberately, and §4.1.1.1\'s general tolerance posture ' +
      'arguably blesses that. Treat acceptance as permitted-latitude and ' +
      'record it; the only defensible failure is a server that MISPARSES the ' +
      'address (e.g. treats " <u@example.com>" as a different mailbox) or ' +
      'wedges. Sending the space is worthwhile as a probe precisely because ' +
      'the divergence is real and interesting.',
    deliberatelyUncovered: {
      reason:
        'lenient parsing of whitespace around the FROM:/TO: colon is common and widely tolerated in practice; a MUST-NOT test would risk false positives on servers that accept a space the RFC forbids. Deferred pending evidence that strict servers are the norm.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-3.3-r',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'If accepted, the SMTP server returns a 354 Intermediate reply',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A transaction with a reverse-path and at least one recipient the ' +
        'server accepts, so DATA is legitimately acceptable.',
    },
    note:
      'PROSE, indicative. Split from R-5321-3.3-s (the rest of the same ' +
      'sentence) because they are different assertions with different tests: ' +
      'this one is a reply code, that one is data-phase parsing behaviour. ' +
      'Quoted without trailing punctuation because the sentence continues into ' +
      '-s; the fragment is unique ("354 Intermediate" appears once). ' +
      'Assert 354 exactly — it is the only 3yz in SMTP and clients key off it ' +
      '(see R-5321-3.3-y). Reply text is free-form as always.',
  },
  {
    id: 'R-5321-3.3-s',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'considers all succeeding lines up to but not including the end of mail ' +
      'data indicator to be the message text.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An accepted transaction in the data phase, plus a recipient the ' +
        'server accepts so the transaction reaches DATA at all.',
    },
    note:
      'PROSE, and the highest-value entry in §3.3 after R-5321-3.3-p, because ' +
      'it is the anti-smuggling rule stated positively: once 354 is issued, ' +
      'NOTHING between there and the terminator is a command. ' +
      'Test: after 354, send a line reading "RSET" (and one reading "QUIT", ' +
      'and a bare "250 OK"), then the terminator. The server must reply ' +
      'exactly once, to the terminator. A server that answers the RSET has ' +
      'left the data phase mid-message — a live command-injection defect. ' +
      'Requires the expectation model to assert "no reply until X" with a ' +
      'timing bound (task #9), same dependency as R-5321-2.4-f. ' +
      'Interacts with §4.5.2 transparency and §2.3.8 line terminators: the ' +
      'nastier variants (bare-LF ".", CR-less terminators) belong to those ' +
      'sections\' entries, not this one. Keep this test to the plain case so ' +
      'a failure localises.',
  },
  {
    id: 'R-5321-3.3-t',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When the end of text is successfully received and stored, the ' +
      'SMTP-receiver sends a "250 OK" reply.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A complete transaction the server accepts end to end: reverse-path, ' +
        'at least one accepted recipient, and a message it will not reject on ' +
        'policy grounds.',
    },
    note:
      'PROSE. Note the RFC restates this a few sentences later on page 21 — ' +
      '"data. If accepted, the SMTP server returns a \'250 OK\' reply." — as ' +
      'part of the end-of-data narrative. That is the same obligation said ' +
      'twice, not a second requirement, so it is NOT registered separately; ' +
      'recorded here so the next reader does not think it was missed. ' +
      'Assert 250, not "OK". Enhanced status codes (250 2.0.0) and queue-id ' +
      'text ("250 2.0.0 Ok: queued as 4A2B1") are universal and conformant. ' +
      'The antecedent "successfully received and stored" plus R-5321-3.3-z\'s ' +
      '"policy or other reasons" means a post-354 5yz is not a failure of ' +
      'this — the server simply did not store it. Reject-or-accept, honestly ' +
      'unfailable against a server with content policy. Our fixture message ' +
      'should be as boring as possible for this reason.',
  },
  {
    id: 'R-5321-3.3-u',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'the end of mail data must be indicated so that the command and reply ' +
      'dialog can be resumed.',
    testability: { kind: 'wire-client' },
    note:
      'PROSE with a lowercase "must" — normative in force, and 5321 predates ' +
      'RFC 8174\'s insistence that only the uppercase form counts. Level MUST ' +
      'on that reading. ' +
      'The mechanism it demands is R-5321-3.3-v (the lone "." line). ' +
      'RECLASSIFIED to wire-client (ADR 0008): a client that never indicates ' +
      'end-of-data just hangs until a server timeout, so the receiver seat ' +
      'learns nothing — but driving our own delivery client, we assert it emits ' +
      'the terminating <CRLF>.<CRLF>. The skipTerminatingDot client-defect is ' +
      'the negative control.',
  },
  {
    id: 'R-5321-3.3-v',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'SMTP indicates the end of the mail data by sending a line containing ' +
      'only a "." (period or full stop).',
    testability: {
      kind: 'wire-with-fixture',
      fixture: 'A transaction that reaches the data phase (accepted recipient).',
    },
    note:
      'PROSE: stated as how the protocol works, but it defines the terminator ' +
      'and both parties are bound — the client sends it, the receiver must ' +
      'recognise it. The receiver half is testable and is really the same ' +
      'observation as R-5321-3.3-t (a 250 after CRLF.CRLF proves recognition). ' +
      'SCOPE: the interesting failures around the terminator are NOT here. ' +
      '"a line containing only a ." says nothing about how the line is ' +
      'delimited (§2.3.8), about dot-stuffing (§4.5.2), or about whether a ' +
      'bare-LF "." must be honoured. Register those against their own ' +
      'sections; a test citing this ID should assert only the plain ' +
      'CRLF.CRLF case. Resist the urge to hang the whole smuggling corpus off ' +
      'this entry — it will make failures unlocalisable.',
  },
  {
    id: 'R-5321-3.3-w',
    section: '3.3',
    page: 20,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The end of mail data indicator also confirms the mail transaction and ' +
      'tells the SMTP server to now process the stored recipients and mail ' +
      'data.',
    testability: {
      kind: 'not-testable',
      reason:
        'Processing and delivery happen after the reply and out of our sight. ' +
        'From a socket, "processed the recipients" and "accepted the bytes and ' +
        'dropped them" are the same 250. Needs a receiving sink and an ' +
        'end-to-end path — the R-5321-2.4-d problem again.',
    },
    note:
      'Text spans the page 20/21 boundary ("...recipients and mail" / ' +
      '"data.") in spec/rfc5321.txt; quoted continuously, and takes page 20 ' +
      'because that is where it starts. ' +
      'The observable shadow of this requirement is R-5321-3.3-t (the 250). ' +
      'This entry is the commitment BEHIND the 250 — that the message will ' +
      'actually be processed — and a server that 250s and silently discards ' +
      'violates it while looking perfect on the wire. That gap is worth ' +
      'stating plainly: our suite cannot detect a black hole. Revisit if ' +
      'task #12 grows an outbound sink.',
  },
  {
    id: 'R-5321-3.3-x',
    section: '3.3',
    page: 21,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If there was no MAIL, or no RCPT, command, or all such commands were ' +
      'rejected, the server MAY return a "command out of sequence" (503) or ' +
      '"no valid recipients" (554) reply in response to the DATA command.',
    testability: { kind: 'wire' },
    note:
      'TRAP, and a nasty one: this is a MAY, so a server that ACCEPTS DATA ' +
      'with no recipients and returns 354 violates nothing in this sentence. ' +
      'A test asserting "DATA without RCPT must be rejected" is wrong — it ' +
      'will fail servers that defer everything to the data phase, which §3.3 ' +
      'itself acknowledges (R-5321-3.3-aa). Score reject as the expected ' +
      'branch, acceptance as permitted-latitude, and record which. ' +
      'Also do not require the specific codes: the sentence offers 503 OR ' +
      '554, and 550/554 with other text is common. Assert 5yz if it rejects. ' +
      'Cheap to exercise (EHLO, MAIL FROM, DATA — no fixture), which is why it ' +
      'is `wire` despite naming recipient state: the "no RCPT" branch needs no ' +
      'valid address. The "all such commands were rejected" branch would need ' +
      'a known-bad recipient and is better tested via R-5321-3.3-i\'s fixture. ' +
      'This entry is what R-5321-3.3-b\'s reset test leans on, and its ' +
      'MAY-ness is exactly why that test is weak in one direction.',
  },
  {
    id: 'R-5321-3.3-y',
    section: '3.3',
    page: 21,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If one of those replies (or any other 5yz reply) is received, the ' +
      'client MUST NOT send the message data; more generally, message data ' +
      'MUST NOT be sent unless a 354 reply is received.',
    testability: { kind: 'wire-client' },
    note:
      'Two rules in one sentence — the 5yz-specific one and the general ' +
      '"only after 354" one — kept as a single entry because both bind the ' +
      'same party the same way. The general clause is the load-bearing one. ' +
      'RECLASSIFIED to wire-client (ADR 0008): nothing a THIRD-PARTY server does ' +
      'reveals whether its client was entitled to send, but we can drive our OWN ' +
      'delivery client against a scripted peer that answers MAIL/RCPT with 5yz ' +
      'and assert the client never opens DATA. The ignore5yzAndSendData ' +
      'client-defect is the negative control — the one place we make our client ' +
      'misbehave on purpose, safely, against a scripted peer rather than a real ' +
      'server whose parser state we would otherwise wreck.',
  },
  {
    id: 'R-5321-3.3-z',
    section: '3.3',
    page: 21,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the verb is initially accepted and the 354 reply issued, the DATA ' +
      'command should fail only if the mail transaction was incomplete (for ' +
      'example, no recipients), if resources were unavailable (including, of ' +
      'course, the server unexpectedly becoming unavailable), or if the server ' +
      'determines that the message should be rejected for policy or other ' +
      'reasons.',
    testability: {
      kind: 'not-testable',
      reason:
        'The final clause — "for policy or other reasons" — makes the ' +
        'permitted-failure list unbounded. Any post-354 rejection can be ' +
        'attributed to policy, and the attribution is server-internal. There ' +
        'is no reply we could see that this sentence forbids.',
    },
    note:
      'PROSE: lowercase "should", so not a 2119 keyword by the letter of RFC ' +
      '8174, but plainly the same force in a document that uses the uppercase ' +
      'form freely elsewhere. Level SHOULD. ' +
      'Registered as the trap it is. It READS like a closed list constraining ' +
      'when DATA may fail — a test author will see "fail only if" and try to ' +
      'assert that an accepted transaction with valid recipients cannot draw a ' +
      'post-data 5yz. It cannot be asserted: "or other reasons" swallows the ' +
      '"only". Note it also silently contradicts the framing sentence two ' +
      'paragraphs up ("The DATA command can fail at only two points in the ' +
      'protocol exchange:"), which is not registered — that sentence is ' +
      'structural signposting for these two paragraphs, and it is wrong on its ' +
      'own terms, since resource failure and policy failure are not one point.',
  },
  {
    id: 'R-5321-3.3-aa',
    section: '3.3',
    page: 21,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'These servers SHOULD treat a failure for one or more recipients as a ' +
      '"subsequent failure" and return a mail message as discussed in Section ' +
      '6 and, in particular, in Section 6.1.',
    testability: {
      kind: 'not-testable',
      reason:
        'The obligation is to generate a BOUNCE — a new message sent back to ' +
        'the reverse-path over a separate connection we are not party to. ' +
        'Observing it needs a mail sink at the return address, out of band ' +
        'from the session under test.',
    },
    note:
      '"These servers" = the ones just described as not verifying recipients ' +
      'until after the message text is received, so the antecedent itself ' +
      'depends on server-internal behaviour we cannot detect: we would first ' +
      'have to know the server defers verification, then know a recipient ' +
      'failed, then catch the bounce. Three unobservables. ' +
      'The paragraph ends with "Using a \'550 mailbox not found\' (or ' +
      'equivalent) reply code after the data are accepted makes it difficult ' +
      'or impossible for the client to determine which recipients failed." — ' +
      'not registered: it is rationale for the SHOULD, stating a consequence ' +
      'rather than an obligation. ' +
      'If task #12 ever provides a sink, this becomes wire-with-fixture and is ' +
      'worth revisiting — deferred-verification bounces are a real interop ' +
      'sore spot (backscatter).',
  },
  {
    id: 'R-5321-3.3-ab',
    section: '3.3',
    page: 21,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Server SMTP systems SHOULD NOT reject messages based on perceived ' +
      'defects in the RFC 822 or MIME (RFC 2045 [21]) message header section ' +
      'or message body.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An accepted transaction (valid reverse-path and recipient) carrying ' +
        'a message with header defects that are unambiguously formal rather ' +
        'than spammy — e.g. a missing Date field, or a malformed but ' +
        'non-suspicious Message-ID.',
    },
    note:
      'The RFC 2045 reference marker "[21]" is part of the sentence and is ' +
      'quoted as printed. ' +
      'Expect near-universal permitted-latitude, and be at peace with it. ' +
      'Rejecting on missing Date/From is standard practice (Sendmail has done ' +
      'it for decades; Exchange and most filtering appliances do it), and ' +
      'twenty years of spam has made this SHOULD NOT largely aspirational. ' +
      'A SHOULD NOT, so a rejection is latitude, not failure — the report ' +
      'should still record it, since which defects a server rejects on is ' +
      'genuinely useful interop information. ' +
      'In tension with R-5321-2.4-j (delivery systems MAY reject mislabeled ' +
      'content) and with R-5321-2.4-i (relays SHOULD NOT inspect content at ' +
      'all). §3.3 does not resolve it. ' +
      'Fixture design matters more than usual here: if the test message ' +
      'trips a spam filter, the 5yz proves nothing about THIS requirement. ' +
      'Keep the defect formal and the content innocuous.',
  },
  {
    id: 'R-5321-3.3-ac',
    section: '3.3',
    page: 21,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In particular, they MUST NOT reject messages in which the numbers of ' +
      'Resent-header fields do not match or Resent-to appears without ' +
      'Resent-from and/or Resent-date.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An accepted transaction (valid reverse-path and recipient) carrying ' +
        'a message with deliberately mismatched Resent- header field counts, ' +
        'and a second with Resent-to but no Resent-from or Resent-date.',
    },
    note:
      'Sharpens the preceding SHOULD NOT (R-5321-3.3-ab) into a hard MUST NOT ' +
      'for one named case, which makes it one of the few genuinely failable ' +
      'content requirements in RFC 5321. Worth a test. ' +
      'Two distinct violations in one sentence, both server-binding and both ' +
      'testable the same way, so one entry with two fixture messages rather ' +
      'than two entries. ' +
      'TRAP: a 5yz here only convicts if the rejection is ATTRIBUTABLE to the ' +
      'Resent- fields. Send a control message identical but for the Resent- ' +
      'defect and require the control to be accepted; without that pairing, a ' +
      'rejection could be greylisting, rate limiting, filtering or policy, and ' +
      'the test is a false positive waiting to happen. ' +
      'Historical curiosity worth knowing: this exists because RFC 822 ' +
      'implementations disagreed about Resent- semantics; RFC 5322 §3.6.6 ' +
      'later made resent blocks explicitly unordered. Almost nothing generates ' +
      'these today, which is precisely why servers are unlikely to have ' +
      'considered them — a plausible place to find a real defect.',
  },
  {
    id: 'R-5321-3.3-ad',
    section: '3.3',
    page: 21,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'Mail transaction commands MUST be used in the order discussed above.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds whoever issues the commands — the client. The receiver\'s ' +
        'enforcement of ordering is §4.1.4, and its one §3.3 instance is ' +
        'R-5321-3.3-p (503 for RCPT before MAIL), which is the testable form.',
    },
    note:
      'The section\'s closing sentence, and easy to mistake for a server ' +
      'requirement because it is unqualified and sits at the end. It is not: ' +
      '"be used" is what a sender does. Do not write a test against this ID; ' +
      'write it against R-5321-3.3-p or against §4.1.4. ' +
      'Our client obeys it except where a corpus case deliberately probes ' +
      'sequencing, and those probes cite the receiver-side entries.',
  },
] as const satisfies readonly RequirementDef[];
