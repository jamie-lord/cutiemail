/**
 * RFC 5321 §4.1.1.5 – §4.1.1.11 — Command Semantics: RSET, VRFY, EXPN, HELP,
 * NOOP, QUIT, and Mail-Parameter/Rcpt-Parameter error responses.
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * A recurring shape in these sections: the normative content is carried by
 * plain indicative prose ("it will return code 555", "the receiver send a
 * '250 OK' reply") rather than by RFC 2119 keywords. Where that prose plainly
 * defines conformance it is registered with `normativeSource: 'prose'` and the
 * reading is justified in `note`.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_1_1_B = [
  // ---------------------------------------------------------------- 4.1.1.5
  {
    id: 'R-5321-4.1.1.5-a',
    section: '4.1.1.5',
    page: 38,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Any stored sender, recipients, and mail data MUST be discarded, and all ' +
      'buffers and state tables cleared.',
    testability: { kind: 'wire' },
    note:
      'The section opens "This command specifies that the current mail ' +
      'transaction will be aborted." — deliberately NOT registered separately. ' +
      'It is the topic sentence and its entire normative content is discharged ' +
      'by this MUST; registering both would double-count one obligation in the ' +
      'denominator. Recorded here so the omission is a decision, not an oversight. ' +
      'Testable without a fixture: MAIL FROM, RSET, then RCPT TO. If the ' +
      'reverse-path buffer was discarded the server must answer 503 (bad ' +
      'sequence), not 250/550. The trap is that 550 (unknown recipient) also ' +
      'looks like a rejection — the test must distinguish 503 from every other ' +
      '5yz, because only 503 proves the sender was forgotten. ' +
      '"all buffers and state tables cleared" reaches server-internal state we ' +
      'cannot see; only the envelope-buffer consequence is observable.',
  },
  {
    id: 'R-5321-4.1.1.5-b',
    section: '4.1.1.5',
    page: 38,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The receiver MUST send a "250 OK" reply to a RSET command with no ' +
      'arguments.',
    testability: { kind: 'wire' },
    note:
      'Assert the code 250, never the literal string "OK". The text after the ' +
      'code is free-form (§4.2.1); real servers say "250 2.0.0 Ok", "250 Reset ' +
      'state", etc. A test matching "250 OK" byte-for-byte would fail nearly ' +
      'every conforming server. ' +
      'Note the qualifier "with no arguments": this MUST says nothing about ' +
      'RSET WITH arguments, and the grammar (rset = "RSET" CRLF) admits none. A ' +
      '501 to "RSET foo" is therefore not a violation of this requirement — do ' +
      'not extend the test that way.',
  },
  {
    id: 'R-5321-4.1.1.5-c',
    section: '4.1.1.5',
    page: 38,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'A reset command may be issued by the client at any time.',
    testability: { kind: 'wire' },
    note:
      'Lowercase "may", so `prose` rather than `keyword` — RFC 2119 force ' +
      'attaches to the capitalised word only. The force is real all the same: ' +
      'it is a client permission whose mirror is a server obligation to accept ' +
      'RSET in any state, and the very next sentence (R-5321-4.1.1.5-d) spells ' +
      'out the awkward states by name. Party `both` for that reason. ' +
      'The observable half is the server\'s: RSET must not draw a 503 for being ' +
      'out of sequence.',
  },
  {
    id: 'R-5321-4.1.1.5-d',
    section: '4.1.1.5',
    page: 38,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'It is effectively equivalent to a NOOP (i.e., it has no effect) if ' +
      'issued immediately after EHLO, before EHLO is issued in the session, ' +
      'after an end of data indicator has been sent and acknowledged, or ' +
      'immediately before a QUIT.',
    testability: { kind: 'wire' },
    note:
      'Stated as fact, hence `prose`, but it enumerates four session states and ' +
      'says RSET is a no-op — i.e. succeeds — in each. A server that answers ' +
      '503 to RSET in any of them contradicts the sentence. Read as MUST. ' +
      'The high-value case is "before EHLO is issued in the session": RFC 5321 ' +
      'requires greeting-then-EHLO, and plenty of servers reject every command ' +
      'before EHLO with 503. This sentence says RSET is not one of them. ' +
      'Expect real divergence here — that is exactly why it is worth a test. ' +
      '"effectively equivalent to a NOOP" means the reply class, not the reply ' +
      'text: assert 250, do not demand the NOOP greeting string.',
  },
  {
    id: 'R-5321-4.1.1.5-e',
    section: '4.1.1.5',
    page: 38,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server MUST NOT close the connection as the result of receiving ' +
      'a RSET; that action is reserved for QUIT (see Section 4.1.1.10).',
    testability: { kind: 'wire' },
    note:
      'Cleanly testable: RSET, then assert the socket is still open and a ' +
      'following NOOP is answered. Cheap and a genuine defect class — some ' +
      'anti-abuse front ends drop after a burst of RSETs (an old spam signal). ' +
      'Beware the attribution trap: a close that happens after several RSETs ' +
      'may be rate limiting rather than "as the result of receiving a RSET". ' +
      'Test with a single RSET in a clean session so the causal link is not ' +
      'arguable.',
  },
  {
    id: 'R-5321-4.1.1.5-f',
    section: '4.1.1.5',
    page: 38,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers SHOULD be prepared for this condition',
    testability: {
      kind: 'not-testable',
      reason:
        'A readiness/robustness posture, not a wire event. "this condition" is ' +
        'an unannounced TCP close or reset; being "prepared" for it has no ' +
        'observable signature — the server survives or it does not, and we have ' +
        'already destroyed the only channel we could observe it on.',
    },
    note:
      'Split from R-5321-4.1.1.5-g: one sentence, two distinct SHOULDs ("be ' +
      'prepared", "treat it as if a QUIT"). Quoted as a fragment because the ' +
      'other half binds different, separately-reasoned behaviour. ' +
      'Note the framing: the paragraph calls the condition "contrary to the ' +
      'intent of this specification", so this SHOULD is about tolerating a peer ' +
      'that has already violated R-5321-4.1.1.10-c.',
  },
  {
    id: 'R-5321-4.1.1.5-g',
    section: '4.1.1.5',
    page: 38,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SHOULD treat it as if a QUIT had been received before the connection ' +
      'disappeared.',
    testability: {
      kind: 'not-testable',
      reason:
        'The behaviour happens after we have dropped the TCP connection, so ' +
        'there is no channel left to observe it on. Distinguishing "treated as ' +
        'QUIT" from "treated as an abort" would need the server\'s own logs or ' +
        'a delivery sink to prove non-delivery of the in-flight transaction — ' +
        'out-of-band either way.',
    },
    note:
      'Subtle and worth recording: treating an abrupt close as QUIT does NOT ' +
      'mean delivering the pending transaction. §4.1.1.10 says a prematurely ' +
      'closed connection MUST cancel any pending transaction (R-5321-4.1.1.10-e), ' +
      'and a QUIT itself aborts an uncompleted transaction (R-5321-4.1.1.10-h). ' +
      'A test author reading this in isolation could easily invert it and assert ' +
      'that a half-sent message gets delivered. It must not be.',
  },

  // ---------------------------------------------------------------- 4.1.1.6
  {
    id: 'R-5321-4.1.1.6-a',
    section: '4.1.1.6',
    page: 38,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command asks the receiver to confirm that the argument identifies a ' +
      'user or mailbox.  If it is a user name, information is returned as ' +
      'specified in Section 3.5.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailbox the server is known to accept, plus a local-part it is ' +
        'known to reject, so a 250 to the first and a 550 to the second can be ' +
        'told apart from a server that answers everything identically. Requires ' +
        'server-side state we cannot create in-band — see task #12.',
    },
    note:
      'Registered as `prose` because it is the only statement of VRFY semantics ' +
      'in the section — without it §4.1.1.6 contributes nothing but the buffer ' +
      'sentence, which would be a false gap in the denominator. Force read as ' +
      'MUST via "information is returned as specified in Section 3.5". ' +
      'THE trap of this whole file. §3.5.1 explicitly permits a server that ' +
      'cannot or will not verify to reply 252, and §3.5.3 blesses 252 as the ' +
      'answer when the server "cannot determine whether or not the mailbox ' +
      'exists" — a posture nearly every modern MTA takes to defeat address ' +
      'harvesting. §5 of RFC 5321 also allows disabling VRFY for site policy, ' +
      'answering 502. So 250, 252, 502, 550 and 551 are ALL defensible here. ' +
      'A test that demands 250 for a valid mailbox fails Postfix, Exim and ' +
      'Sendmail in their default configurations. Record the posture taken ' +
      '(`permitted-latitude`); do not fail on it. The only genuine failure is a ' +
      'reply outside the permitted set, or a 5xx that is not one of the ' +
      'sanctioned refusals.',
  },
  {
    id: 'R-5321-4.1.1.6-b',
    section: '4.1.1.6',
    page: 38,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer.',
    testability: { kind: 'wire' },
    note:
      'Stated as fact about the command, hence `prose`; the force on the ' +
      'receiver is MUST NOT (do not touch the buffers). ' +
      'Testable with no fixture, which is not obvious: MAIL FROM, then VRFY, ' +
      'then RCPT TO an address we expect to be refused. If VRFY had cleared the ' +
      'reverse-path buffer the RCPT draws 503 (bad sequence); if the buffer ' +
      'survived it draws 550/551/250. Distinguishing 503 from any other reply ' +
      'is the whole assertion — we never need a deliverable recipient. ' +
      'Quoting note: this exact sentence prefix recurs in §4.1.1.7, §4.1.1.8 and ' +
      '§4.1.1.9. Here it ends at "buffer." with no "and it may be issued at any ' +
      'time" clause — §4.1.1.6 is the only one of the four that omits it, so ' +
      'the shorter quote is the honest one and VRFY carries no ' +
      '"issue at any time" permission. Do not paste in the longer form.',
  },

  // ---------------------------------------------------------------- 4.1.1.7
  {
    id: 'R-5321-4.1.1.7-a',
    section: '4.1.1.7',
    page: 39,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command asks the receiver to confirm that the argument identifies a ' +
      'mailing list, and if so, to return the membership of that list.  If the ' +
      'command is successful, a reply is returned containing information as ' +
      'described in Section 3.5.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list address the server is known to expand, with a known ' +
        'membership, so the returned members can be checked against a truth. ' +
        'Requires server-side state we cannot create in-band — see task #12, ' +
        'and note that most MTAs have no mailing-list concept at all.',
    },
    note:
      'Same shape as R-5321-4.1.1.6-a and the same latitude, only more so: §3.5.1 ' +
      'permits refusing EXPN and §7.3 recommends offering the ability to disable ' +
      'it outright as an anti-harvesting measure. 502 and 550 are the ' +
      'overwhelmingly common answers in the field and both are conforming. ' +
      'The conditional "and if so" is load-bearing: the obligation to return ' +
      'membership only bites when the argument IS a list. A server for which no ' +
      'argument is ever a list vacuously satisfies this. Expect ' +
      '`permitted-latitude` on essentially every target.',
  },
  {
    id: 'R-5321-4.1.1.7-b',
    section: '4.1.1.7',
    page: 39,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This reply will have multiple lines except in the trivial case of a ' +
      'one-member list.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A mailing list with two or more known members that the server will ' +
        'actually expand — i.e. R-5321-4.1.1.7-a\'s fixture, plus a guarantee ' +
        'the list is not a one-member list.',
    },
    note:
      'Split from -a: different testability. -a is about content, this is about ' +
      'the multiline reply FORM (§4.2.1 hyphen continuation), which a client can ' +
      'check structurally without knowing the membership. Registered `prose` — ' +
      '"will have" is indicative, but a single-line reply listing three members ' +
      'would contradict the specification. ' +
      'Only bites on a successful expansion. A refusal (502/550) is single-line ' +
      'and is not a violation — "This reply" means the success reply of the ' +
      'preceding sentence. A test must gate on 2yz before asserting multiline, ' +
      'or it will fail every server that sensibly disables EXPN.',
  },
  {
    id: 'R-5321-4.1.1.7-c',
    section: '4.1.1.7',
    page: 39,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'Same reading and same fixture-free test as R-5321-4.1.1.6-b (MAIL FROM, ' +
      'EXPN, RCPT, assert not-503). Registered separately rather than merged ' +
      'with VRFY\'s because the sentence is a distinct normative statement in a ' +
      'distinct section and the trailing clause differs — merging would hide ' +
      'that EXPN carries an "any time" permission VRFY does not. ' +
      'The "may be issued at any time" half is split out as R-5321-4.1.1.7-d; ' +
      'this entry\'s quote necessarily contains it because the RFC puts both in ' +
      'one sentence and the verbatim rule forbids trimming to taste. The two ' +
      'entries overlap textually and that is fine — they assert different things.',
  },
  {
    id: 'R-5321-4.1.1.7-d',
    section: '4.1.1.7',
    page: 39,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'Lowercase "may", hence `prose`. Client permission with a mirrored server ' +
      'obligation: EXPN must not draw a 503-for-sequence, including before EHLO ' +
      'and in the middle of a transaction. That is the observable half. ' +
      'This quote is a bare fragment and is NOT unique in the document — it also ' +
      'closes the equivalent sentences in §4.1.1.8 and §4.1.1.9. The verbatim ' +
      'test is a substring check so it passes, but a human locating this by ' +
      'grep will land on the wrong section: it is the EXPN instance, page 39, ' +
      'line 2144. Uniqueness cannot be bought by extending the quote either — ' +
      'the preceding words are identical in all three. Recorded here rather ' +
      'than silently tolerated.',
  },

  // ---------------------------------------------------------------- 4.1.1.8
  {
    id: 'R-5321-4.1.1.8-a',
    section: '4.1.1.8',
    page: 39,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command causes the server to send helpful information to the client.',
    testability: { kind: 'wire' },
    note:
      '`prose`: "causes the server to" is indicative but it is the only ' +
      'statement of what HELP does, and R-5321-4.1.1.8-e independently says ' +
      'servers SHOULD support HELP without arguments — so the pair has the ' +
      'force of "answer 211/214 if you support it". ' +
      'Do not try to assert "helpful". There is no machine-checkable definition ' +
      'of helpful information, and the RFC gives none. The assertable content is ' +
      'the reply code: §4.2.1 lists 211 and 214 for HELP, and 502 (not ' +
      'implemented) is the sanctioned refusal that R-5321-4.1.1.8-e\'s SHOULD ' +
      'permits. Treat 502 as `permitted-latitude`. ' +
      'Watch for servers that answer 214 with an empty or single-word text — ' +
      'unhelpful, conforming, and not our business to fail.',
    deliberatelyUncovered: {
      reason:
        'the "helpful information" content has no machine-checkable definition (the RFC gives none), and the only observable — a 211/214 to HELP — is entirely conditional on HELP being supported, which §4.1.1.8-e makes only a SHOULD. A 500/502 to HELP is permitted-latitude (many hardened MTAs disable HELP), so there is no MUST violation a server can commit here that is distinguishable from a permitted decline. The support-vs-decline branch is profiled instead by the §4.1.1.8-e latitude case (help-supported), which never produces a finding. (A former MUST test wrongly convicted a 500 to HELP; this replaces it.)',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.1.8-b',
    section: '4.1.1.8',
    page: 39,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The command MAY take an argument (e.g., any command name) and return ' +
      'more specific information as a response.',
    testability: { kind: 'wire' },
    note:
      'Permission, so unfailable in either direction — but the posture is worth ' +
      'recording, so run it and report `permitted-latitude`. ' +
      'This overlaps R-5321-4.1.1.8-e\'s "MAY support it with arguments"; both ' +
      'are registered because both are separate MAY keywords in the RFC and the ' +
      'register counts requirements, not ideas. Note the difference in what they ' +
      'permit: this one permits returning MORE SPECIFIC information, -f merely ' +
      'permits supporting the argument form at all. A server that accepts "HELP ' +
      'RCPT" and returns its generic blurb takes -f\'s permission but not this ' +
      'one, and violates neither.',
  },
  {
    id: 'R-5321-4.1.1.8-c',
    section: '4.1.1.8',
    page: 39,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'The HELP instance of the recurring sentence (page 39, line 2158). Same ' +
      'reading and same fixture-free test as R-5321-4.1.1.6-b: MAIL FROM, HELP, ' +
      'RCPT, assert the reply is not 503. ' +
      'Textually identical to R-5321-4.1.1.7-c, so a grep will not tell them ' +
      'apart — the verbatim test only proves the words exist somewhere in the ' +
      'RFC, not that they exist in the section we claim. That is a known ' +
      'weakness of the invariant, not a defect in this entry.',
  },
  {
    id: 'R-5321-4.1.1.8-d',
    section: '4.1.1.8',
    page: 39,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'The HELP instance. See R-5321-4.1.1.7-d for the reading and for the ' +
      'non-uniqueness of this fragment; this one is page 39, line 2159. ' +
      'Observable half: HELP before EHLO, and HELP mid-transaction, must not ' +
      'draw 503. HELP before EHLO is the interesting probe — a server that ' +
      'greets and then 503s everything until EHLO violates this (and -c) ' +
      'without ever violating anything in §4.1.1.1.',
  },
  {
    id: 'R-5321-4.1.1.8-e',
    section: '4.1.1.8',
    page: 39,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SMTP servers SHOULD support HELP without arguments',
    testability: { kind: 'wire' },
    note:
      'Split from R-5321-4.1.1.8-f: one sentence, two keywords, two levels ' +
      '(SHOULD vs MAY), so two entries. Quoted as a fragment for that reason. ' +
      'Cheap and clean to test — bare "HELP" and check for 211/214. A 502 is ' +
      '`permitted-latitude`, not failure: it is a SHOULD, and a fair number of ' +
      'hardened MTAs disable HELP. Do not let the ease of the test tempt anyone ' +
      'into scoring 502 as a defect.',
  },
  {
    id: 'R-5321-4.1.1.8-f',
    section: '4.1.1.8',
    page: 39,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'and MAY support it with arguments.',
    testability: { kind: 'wire' },
    note:
      'The MAY half of the sentence split at R-5321-4.1.1.8-e. Unfailable; ' +
      'record the posture only. ' +
      'The quote is trimmed to the clause and keeps the RFC\'s trailing full ' +
      'stop. Note the asymmetry the split exposes: HELP without arguments is a ' +
      'SHOULD, HELP with arguments is a MAY — so "HELP RCPT" drawing 501 or 504 ' +
      'while bare "HELP" works is fully conforming. A naive test that sends only ' +
      'the argument form and scores the result against the SHOULD would ' +
      'mis-attribute a permitted refusal as a SHOULD violation. Test the two ' +
      'forms separately.',
  },

  // ---------------------------------------------------------------- 4.1.1.9
  {
    id: 'R-5321-4.1.1.9-a',
    section: '4.1.1.9',
    page: 40,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command does not affect any parameters or previously entered ' +
      'commands.',
    testability: { kind: 'wire' },
    note:
      '`prose`: "does not affect" is indicative but a NOOP that clobbered ' +
      'session state would plainly contradict the specification. Force: MUST NOT. ' +
      'Broader than the buffer sentence that follows (R-5321-4.1.1.9-c) — "any ' +
      'parameters or previously entered commands" reaches EHLO-negotiated ' +
      'extension state too, so a worthwhile probe is EHLO, NOOP, then check the ' +
      'session still behaves as extended (e.g. MAIL FROM with a SIZE parameter ' +
      'is still accepted). Most of that state is invisible until exercised, so ' +
      'the test can only sample it; do not claim this requirement is fully ' +
      'covered by one assertion.',
  },
  {
    id: 'R-5321-4.1.1.9-b',
    section: '4.1.1.9',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'It specifies no action other than that the receiver send a "250 OK" ' +
      'reply.',
    testability: { kind: 'wire' },
    note:
      '`prose` — the obligation is carried by "the receiver send a \'250 OK\' ' +
      'reply", with no keyword. Read as MUST; this is the operative requirement ' +
      'of the whole section. ' +
      'As with R-5321-4.1.1.5-b: assert the code 250, never the literal "OK". ' +
      'The text is free-form and real servers vary ("250 2.0.0 Ok", "250 OK", ' +
      '"250 mail.example.com"). ' +
      'The "no action other than" half is the unobservable half — we cannot see ' +
      'that a server did nothing, only that it replied 250. Do not over-claim ' +
      'coverage of this entry on the strength of the reply-code assertion alone.',
  },
  {
    id: 'R-5321-4.1.1.9-c',
    section: '4.1.1.9',
    page: 40,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This command has no effect on the reverse-path buffer, the forward-path ' +
      'buffer, or the mail data buffer, and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'The NOOP instance of the recurring sentence (page 40, line 2196). See ' +
      'R-5321-4.1.1.6-b for the reading and the fixture-free test. ' +
      'Textually identical to R-5321-4.1.1.7-c and R-5321-4.1.1.8-c — three ' +
      'entries, one string. The register counts three requirements here because ' +
      'the RFC states three, each binding the server\'s handling of a different ' +
      'command. Collapsing them to one would understate the denominator and, ' +
      'worse, let a server that gets NOOP right and EXPN wrong look uniform.',
  },
  {
    id: 'R-5321-4.1.1.9-d',
    section: '4.1.1.9',
    page: 40,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'and it may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'The NOOP instance; page 40, line 2197. See R-5321-4.1.1.7-d. ' +
      'NOOP is the best probe of the three for the "any time" rule, because it ' +
      'is the one command with no argument requirements and no side effects — a ' +
      '503 to NOOP before EHLO is unambiguously this violation and nothing else. ' +
      'It is also the one most likely to be special-cased by pre-greeting ' +
      'pipelining defences, which is precisely why it is worth sending.',
  },
  {
    id: 'R-5321-4.1.1.9-e',
    section: '4.1.1.9',
    page: 40,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If a parameter string is specified, servers SHOULD ignore it.',
    testability: { kind: 'wire' },
    note:
      'Testable: "NOOP whatever" should draw 250, same as bare NOOP. "Ignore" is ' +
      'observable here precisely because the grammar (noop = "NOOP" [ SP String ] ' +
      'CRLF) admits the argument — so ignoring it means accepting it, and the ' +
      'contrary behaviour (501 syntax error) is visible. ' +
      'SHOULD, so a 501 is `permitted-latitude`, not failure. ' +
      'Contrast R-5321-4.1.1.8-f: HELP explicitly MAY act on its argument, NOOP ' +
      'SHOULD ignore its own. Same optional-String grammar, opposite advice. A ' +
      'test author who generalises "optional argument" handling across the two ' +
      'will get one of them wrong.',
  },

  // --------------------------------------------------------------- 4.1.1.10
  {
    id: 'R-5321-4.1.1.10-a',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'This command specifies that the receiver MUST send a "221 OK" reply, and ' +
      'then close the transmission channel.',
    testability: { kind: 'wire' },
    note:
      'One MUST covering two observable acts (reply 221; then close). Not split ' +
      '— same party, same keyword, same test, and splitting would require ' +
      'quoting "and then close the transmission channel." as a fragment for no ' +
      'analytical gain. ' +
      'Assert the code 221 only. "221 OK" is the RFC\'s own shorthand and is ' +
      'contradicted by its own §4.2.1 table and by every example in §D, which ' +
      'show "221 <domain> Service closing transmission channel". A test matching ' +
      'the string "OK" here fails literally everything. ' +
      'Ordering matters and is testable: the reply must arrive BEFORE the FIN. A ' +
      'server that closes without replying, or resets rather than closing ' +
      'cleanly, violates this — and an RST can eat the buffered 221, so read to ' +
      'EOF before judging.',
  },
  {
    id: 'R-5321-4.1.1.10-b',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The receiver MUST NOT intentionally close the transmission channel until ' +
      'it receives and replies to a QUIT command (even if there was an error).',
    testability: { kind: 'wire' },
    note:
      'Looks absolute; is not. "intentionally" is doing enormous work, and other ' +
      'parts of 5321 sanction closing without a QUIT: §3.8 and §4.2.1 give 421 ' +
      '(service not available, closing transmission channel), and §4.5.3.2 sets ' +
      'timeouts after which the server may abandon the session. The parenthetical ' +
      '"(even if there was an error)" is the real target — a server that hangs up ' +
      'after a single 500 or 550 violates this squarely. ' +
      'The false-positive risk is high and specific: nearly every production MTA ' +
      'drops the connection after N bad commands or on rate limiting, usually ' +
      'with a 421 first. Treat "421 then close" as `permitted-latitude`, and ' +
      'reserve failure for a close with NO reply or a close after an ordinary ' +
      'error reply in an otherwise well-behaved session. Test with ONE error, ' +
      'not a burst, or the result is unattributable.',
  },
  {
    id: 'R-5321-4.1.1.10-c',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The sender MUST NOT intentionally close the transmission channel until ' +
      'it sends a QUIT command,',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client — that is us. Nothing about our own conduct ' +
        'is an observation of the server. Registered so the denominator stays ' +
        'honest, not because a test can exist.',
    },
    note:
      'Our client will deliberately violate this in the tests for ' +
      'R-5321-4.1.1.5-f/g (abrupt close, treated as QUIT) and ' +
      'R-5321-4.1.1.10-e (premature close cancels the pending transaction) — ' +
      'those requirements are ONLY reachable by breaking this one. Same pattern ' +
      'as R-5321-2.4-g. The suite should not be quietly "fixed" to conform here.',
  },
  {
    id: 'R-5321-4.1.1.10-d',
    section: '4.1.1.10',
    page: 40,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'and it SHOULD wait until it receives the reply (even if there was an ' +
      'error response to a previous command).',
    testability: {
      kind: 'not-testable',
      reason:
        'A client obligation to wait for the 221 before closing. Whether we ' +
        'wait is our own conduct, not the server\'s behaviour; there is no ' +
        'server-side assertion corresponding to it.',
    },
    note:
      'Split from R-5321-4.1.1.10-c: one sentence, different levels (MUST NOT vs ' +
      'SHOULD), hence two entries. Both bind the client, so the split buys no ' +
      'testability — it buys an accurate count. ' +
      'Practical consequence for the harness, though: our client SHOULD read the ' +
      '221 before closing, which means QUIT handling needs a read timeout rather ' +
      'than a fire-and-forget close. That is also how R-5321-4.1.1.10-a gets ' +
      'observed at all.',
  },
  {
    id: 'R-5321-4.1.1.10-e',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the connection is closed prematurely due to violations of the above ' +
      'or system or network failure, the server MUST cancel any pending ' +
      'transaction, but not undo any previously completed transaction,',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A delivery sink we can inspect out-of-band: a mailbox the server ' +
        'accepts and whose contents we can read back. The test completes one ' +
        'transaction, starts a second, drops the TCP connection mid-DATA, then ' +
        'asserts the first message arrived and the second did not. Neither half ' +
        'is visible on the SMTP connection we just destroyed — see task #12.',
    },
    note:
      'Two obligations in one MUST (cancel the pending one; do not undo the ' +
      'completed one). Kept as one entry: identical party, and both need exactly ' +
      'the same fixture and the same experiment, so splitting would produce two ' +
      'entries with one test. ' +
      'The "not undo any previously completed transaction" half is the one that ' +
      'bites in practice — a server that treats a dropped connection as "roll ' +
      'back the session" would violate it, and this is the requirement that ' +
      'makes message duplication after a failed QUIT the client\'s problem, not ' +
      'the server\'s. Deeply worth testing if task #12 ever gives us a sink; ' +
      'untestable and honestly so until then.',
  },
  {
    id: 'R-5321-4.1.1.10-f',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'and generally MUST act as if the command or transaction in progress had ' +
      'received a temporary error (i.e., a 4yz response).',
    testability: {
      kind: 'not-testable',
      reason:
        'The 4yz is notional: the connection is already gone, so no reply can ' +
        'be delivered to anyone. This describes the server\'s internal ' +
        'treatment of the aborted work (retryable, not permanently failed), ' +
        'which surfaces only in its queue, its logs, or a bounce we have no ' +
        'path to receive.',
    },
    note:
      'The classic looks-testable-isn\'t entry of this section, and the reason ' +
      'it is kept: a test author sees "4yz response" and starts hunting for a ' +
      '4yz on the wire. There is no wire. The connection closed prematurely — ' +
      'that is the precondition of the sentence. ' +
      '"generally" further hedges an already-unobservable MUST. Note the ' +
      'contrast with R-5321-4.1.1.10-e, whose consequences a delivery sink could ' +
      'actually reveal; no fixture reveals this one, because "acted as if it ' +
      'were a 4yz" and "silently dropped it" are indistinguishable from outside.',
  },
  {
    id: 'R-5321-4.1.1.10-g',
    section: '4.1.1.10',
    page: 40,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'The QUIT command may be issued at any time.',
    testability: { kind: 'wire' },
    note:
      'Lowercase "may", hence `prose`; force is a client permission mirrored by ' +
      'a server obligation to honour QUIT in any state. Party `both`. ' +
      'The server half is testable and cheap: QUIT before EHLO, and QUIT in the ' +
      'middle of DATA-collection... except the second is a trap. Inside the DATA ' +
      'phase the octets "QUIT<CRLF>" are message content, not a command — §4.1.1.4 ' +
      'says the receiver treats everything until <CRLF>.<CRLF> as data. "At any ' +
      'time" means at any point a command is being read, NOT during DATA. A test ' +
      'that sends QUIT mid-DATA and expects 221 is asserting the opposite of ' +
      'what the RFC requires. Probe it before EHLO and between MAIL and RCPT.',
  },
  {
    id: 'R-5321-4.1.1.10-h',
    section: '4.1.1.10',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'Any current uncompleted mail transaction will be aborted.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A delivery sink we can inspect out-of-band. Start a transaction ' +
        '(MAIL/RCPT, optionally DATA without the terminating dot), send QUIT, ' +
        'then assert nothing was delivered. The 221 tells us nothing about ' +
        'whether the partial transaction was dropped — see task #12.',
    },
    note:
      '`prose`: indicative "will be aborted", but a server that delivered a ' +
      'half-built transaction on QUIT would contradict the specification ' +
      'outright. Force: MUST. ' +
      'Nothing on the SMTP connection distinguishes "aborted" from "delivered ' +
      'anyway" — the reply is 221 either way and then the channel is gone. That ' +
      'is why this is fixture-bound despite looking like a two-line wire test. ' +
      'Pairs with R-5321-4.1.1.5-g: an abrupt close is to be treated as a QUIT, ' +
      'and this is what a QUIT does to a pending transaction. The two entries ' +
      'are the same experiment with a different ending.',
  },

  // --------------------------------------------------------------- 4.1.1.11
  {
    id: 'R-5321-4.1.1.11-a',
    section: '4.1.1.11',
    page: 40,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the server SMTP does not recognize or cannot implement one or more of ' +
      'the parameters associated with a particular MAIL FROM or RCPT TO ' +
      'command, it will return code 555.',
    testability: { kind: 'wire' },
    note:
      '`prose`: "it will return code 555" is indicative and there is no keyword ' +
      'anywhere in §4.1.1.11, yet it names an exact code for an exact condition. ' +
      'Read as MUST. If we decline to register it, the section contributes ' +
      'nothing and 555 vanishes from the denominator. ' +
      'Testable with no fixture — MAIL FROM:<a@b> XNOTAPARAM=1 — and this is the ' +
      'entry most likely to produce a genuine, reproducible non-conformance, ' +
      'because 555 is poorly implemented. Expect 501, 504 and 555 in the field. ' +
      'Before scoring: R-5321-4.1.1.11-c says parameter-specific errors are ' +
      'defined in the parameter\'s own RFC, so use a parameter name no RFC ' +
      'defines (an X- name), or the target can legitimately answer with some ' +
      'other code. Note also the deliberate distinction from 501: 555 is for a ' +
      'syntactically well-formed parameter that is unrecognised, so the probe ' +
      'must be valid esmtp-param syntax per §4.1.2 or a 501 is the server being ' +
      'right and us being sloppy.',
    deliberatelyUncovered: {
      reason:
        'testing the response to an unimplemented MAIL/RCPT parameter requires knowing a parameter the server does NOT implement; that is server-specific, so a portable negative control cannot be built without a per-target fixture.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.1.1.11-b',
    section: '4.1.1.11',
    page: 40,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If, for some reason, the server is temporarily unable to accommodate one ' +
      'or more of the parameters associated with a MAIL FROM or RCPT TO ' +
      'command, and if the definition of the specific parameter does not ' +
      'mandate the use of another code, it should return code 455.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server that is temporarily unable to honour a parameter it does ' +
        'recognise — e.g. an advertised extension backed by a dependency we can ' +
        'take offline for the duration of the test. There is no in-band way to ' +
        'make a server temporarily unwell; this needs a cooperating target we ' +
        'control. See task #12.',
    },
    note:
      'Lowercase "should", hence `prose`, with SHOULD force. ' +
      'The precondition is the problem: "temporarily unable" is a state of the ' +
      'server, not of the command, and no sequence of bytes induces it. This ' +
      'looks like a sibling of -a and is nothing like as testable — an easy ' +
      'mistake to make from the shape of the paragraph alone. ' +
      'Doubly hedged: "for some reason", "should", and the escape clause for ' +
      'parameters whose own RFC mandates another code. Even with a cooperating ' +
      'target, a 4yz other than 455 is `permitted-latitude`. Realistically only ' +
      'testable against our own reference server, if we ever build one.',
  },
  {
    id: 'R-5321-4.1.1.11-c',
    section: '4.1.1.11',
    page: 41,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Errors specific to particular parameters and their values will be ' +
      'specified in the parameter\'s defining RFC.',
    testability: {
      kind: 'not-testable',
      reason:
        'A statement about where OTHER specifications document their error ' +
        'codes. It binds the authors of extension RFCs, not an SMTP ' +
        'implementation, and no wire event corresponds to it — the same shape as ' +
        'R-5321-2.4-o, which constrains how a rule is read rather than what a ' +
        'party does.',
    },
    note:
      'Falls on page 41, after the page break — the rest of §4.1.1.11 is on ' +
      'page 40. Checked, not guessed. ' +
      'Registered despite being unassertable because it is the escape clause ' +
      'that governs the two requirements above it: whenever an extension\'s own ' +
      'RFC names a code, that code wins over 555 and 455. Any test for -a or -b ' +
      'must honour this by probing with parameters no RFC defines. Deleting this ' +
      'entry would hide the reason those tests are written the way they are.',
  },
] as const satisfies readonly RequirementDef[];
