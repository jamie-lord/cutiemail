/**
 * RFC 5321 §3.8 — Terminating Sessions and Connections
 * RFC 5321 §3.9 — Mailing Lists and Aliases
 * RFC 5321 §3.9.1 — Alias
 * RFC 5321 §3.9.2 — List
 *
 * Verbatim quotes from spec/rfc5321.txt (lines 1640-1747). Do not paraphrase:
 * the register's `every requirement quotes RFC 5321 verbatim` test checks every
 * `text` field against the vendored RFC and will fail on drift.
 *
 * Character of this range: §3.8 is the most wire-testable prose in §3 — it is
 * about when a server is allowed to hang up, which we can observe directly by
 * having the socket die. §3.9 and its subsections are almost entirely the
 * opposite: they bind an expander's treatment of an envelope we never see,
 * downstream of a delivery we cannot follow. The split in `testability` below
 * is stark for that reason, and it is real, not laziness.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_8 = [
  {
    id: 'R-5321-3.8-a',
    section: '3.8',
    page: 30,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'An SMTP connection is terminated when the client sends a QUIT command. ' +
      'The server responds with a positive reply code, after which it closes ' +
      'the connection.',
    testability: { kind: 'wire' },
    note:
      'Stated as fact, no keyword, hence `prose` — but it is plainly binding ' +
      'behaviour: the next paragraph makes closing at any OTHER time a MUST ' +
      'NOT, which only means anything if closing HERE is mandatory. ' +
      'Trap for the test author: this paragraph says "a positive reply code", ' +
      'the exception bullet in R-5321-3.8-b says "a 221 reply", and §4.3.2 ' +
      'pins QUIT to 221. Assert 2yz here and let R-5321-3.8-b carry the ' +
      'specific 221 — otherwise the same defect gets counted twice, and this ' +
      'entry fails a server for a reason its own sentence does not state. ' +
      'Second trap: "after which it closes" is an ordering claim. A server ' +
      'that closes WITHOUT replying, or replies after FIN, violates this; ' +
      'testing it needs the reply read and the close observed as ordered ' +
      'events, so it depends on the expectation model carrying timeouts ' +
      '(task #9). A read of 221 followed by EOF is the pass.',
  },
  {
    id: 'R-5321-3.8-b',
    section: '3.8',
    page: 30,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server MUST NOT intentionally close the connection under normal ' +
      'operational circumstances (see Section 7.8) except: ' +
      'o After receiving a QUIT command and responding with a 221 reply. ' +
      'o After detecting the need to shut down the SMTP service and returning ' +
      'a 421 response code. This response code can be issued after the server ' +
      'receives any command or, if necessary, asynchronously from command ' +
      'receipt (on the assumption that the client will receive it after the ' +
      'next command is issued). ' +
      'o After a timeout, as specified in Section 4.5.3.2, occurs waiting for ' +
      'the client to send a command or data.',
    testability: { kind: 'wire' },
    note:
      'Quoted with the three exception bullets attached, including their "o" ' +
      'markers, because the exceptions ARE the requirement — the lead-in ' +
      'sentence alone ends in a colon and forbids nothing on its own. The ' +
      'normaliser collapses whitespace, so the bullet layout does not matter ' +
      'but the "o" tokens must be present. ' +
      'This is the single most valuable assertion in §3.8 and the hardest to ' +
      'write fairly. Three escape hatches a naive test will trip over: ' +
      '(1) "intentionally" — a close we observe may be a crash, a middlebox, ' +
      'or an idle reaper, and the wire cannot tell us which; ' +
      '(2) the 421 exception is nearly unfalsifiable, because a server may ' +
      'declare a shutdown at any moment and MAY emit the 421 asynchronously, ' +
      'so "421 then close" is always conformant and we can never prove the ' +
      'need to shut down was fabricated; ' +
      '(3) "under normal operational circumstances (see Section 7.8)" — §7.8 ' +
      'is about denial of service, and explicitly contemplates dropping ' +
      'abusive clients. A rate-limited or greylisted probe is OUTSIDE this ' +
      'requirement, so a suite that hammers a server and then fails it for ' +
      'hanging up is producing a false positive about its own behaviour. ' +
      'The honest assertion is narrow: a bare close (no reply line at all) ' +
      'after a well-formed command, early in a low-rate session, is a ' +
      'violation. Anything with a 221, a 421, or a preceding timeout is not.',
  },
  {
    id: 'R-5321-3.8-c',
    section: '3.8',
    page: 30,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'In particular, a server that closes connections in response to commands ' +
      'that are not understood is in violation of this specification.',
    testability: { kind: 'wire' },
    note:
      'The clearest `prose` entry in the range: "is in violation of this ' +
      'specification" names the contrary behaviour a violation outright, ' +
      'exactly the §2.4 pattern the register\'s `prose` category was created ' +
      'for. MUST NOT in force without the word. ' +
      'Registered separately from R-5321-3.8-b even though it is a specific ' +
      'case of it, because it is the case we can actually test cleanly: send ' +
      'a garbage verb (XYZZY) on an otherwise idle, well-behaved session and ' +
      'assert the connection survives. Here "intentionally" is not a defence — ' +
      'the RFC has pre-judged the intent. ' +
      'Note the ordering with R-5321-3.8-d: this entry fails a server for the ' +
      'CLOSE; d fails it for the reply code. A server that replies 500 and ' +
      'then closes fails this one and passes that one. Keep them independent.',
  },
  {
    id: 'R-5321-3.8-d',
    section: '3.8',
    page: 30,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Servers are expected to be tolerant of unknown commands, issuing a 500 ' +
      'reply and awaiting further instructions from the client.',
    testability: { kind: 'wire' },
    note:
      '`prose`: "are expected to be" carries obligation without a keyword. ' +
      'Levelled SHOULD rather than MUST deliberately — "expected to" is ' +
      'softer than the neighbouring "is in violation of this specification", ' +
      'and the register should not inflate it. This is an interpretation; it ' +
      'is recorded here so a reader can disagree with it. ' +
      'The trap: do NOT assert exactly 500. §4.2.4 gives 500 for syntax ' +
      'error/command unrecognized and 502 for command not implemented, and ' +
      'real servers split unknown verbs across both — Postfix says 502 for ' +
      'some, 500 for others. Assert 5yz and record the specific code in the ' +
      'matrix. A test demanding literal 500 would fail most of the deployed ' +
      'internet for a defensible reading of a different section. ' +
      '"awaiting further instructions" is the same claim as R-5321-3.8-c ' +
      'seen from the reply side; a following NOOP should still get 250.',
  },
  {
    id: 'R-5321-3.8-e',
    section: '3.8',
    page: 30,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server that is forcibly shut down via external means SHOULD ' +
      'attempt to send a line containing a 421 response code to the SMTP ' +
      'client before exiting.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An open, idle session against a server we can kill out-of-band ' +
        'mid-connection (SIGTERM to the daemon, or a container stop) while ' +
        'holding the socket open and reading. Needs process-level control of ' +
        'the target, which the suite has only against our own fixture servers ' +
        '— never against a third-party host under test. See task #12.',
    },
    note:
      'Looks not-testable and is in fact reachable, but only in the fixture ' +
      'lane: nothing a client can SEND causes a forcible external shutdown, ' +
      'so this is unassertable against any real-world target. Recorded as ' +
      'wire-with-fixture rather than not-testable because the reason is a ' +
      'missing harness capability, not a missing wire event — the 421 line ' +
      'would appear on our socket if it were sent. ' +
      'Note "attempt to" inside a SHOULD: a server that tries and loses the ' +
      'race with the kernel has complied. Combined with SIGKILL being ' +
      'uncatchable, absence of the 421 is `permitted-latitude`, never a ' +
      'failure. Genuinely low value; a candidate for deliberate non-coverage ' +
      'once run once. ' +
      'The following sentence — "The SMTP client will normally read the 421 ' +
      'response code after sending its next command." — is deliberately NOT ' +
      'registered: "will normally" describes what happens, binds no party, ' +
      'and defines no conformance.',
  },
  {
    id: 'R-5321-3.8-f',
    section: '3.8',
    page: 30,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP clients that experience a connection close, reset, or other ' +
      'communications failure due to circumstances not under their control (in ' +
      'violation of the intent of this specification but sometimes unavoidable) ' +
      'SHOULD, to maintain the robustness of the mail system, treat the mail ' +
      'transaction as if a 451 response had been received and act accordingly.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. It tells OUR side how to interpret an unexpected ' +
        'close; there is no server behaviour to assert, and a suite cannot ' +
        'test itself against the register.',
    },
    note:
      'Worth reading as instruction to the suite\'s own client rather than as ' +
      'a test target: when R-5321-3.8-b or -c catches a bare close, this ' +
      'sentence says the correct client posture is to treat it as a transient ' +
      '451, i.e. retry rather than bounce. The parenthetical "(in violation of ' +
      'the intent of this specification but sometimes unavoidable)" is the ' +
      'RFC conceding that R-5321-3.8-b gets broken in the field, which is ' +
      'precisely why -b is worth measuring.',
  },
  {
    id: 'R-5321-3.9-a',
    section: '3.9',
    page: 31,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP-capable host SHOULD support both the alias and the list models ' +
      'of address expansion for multiple delivery.',
    testability: {
      kind: 'not-testable',
      reason:
        'Support for expansion models is a property of the host\'s delivery ' +
        'configuration, not of its SMTP dialogue. Nothing in EHLO, a reply ' +
        'code, or a transaction distinguishes a host that expands lists from ' +
        'one that does not.',
    },
    note:
      'Tempting false lead: EXPN (§4.1.1.6) looks like the observable handle ' +
      'on this, and it is not. EXPN interrogates a list\'s membership and is ' +
      'routinely disabled for privacy (§7.3 explicitly permits refusing it); ' +
      'a 502 to EXPN says nothing whatever about whether the host supports ' +
      'the list model. Any test wiring this requirement to EXPN would be ' +
      'measuring the wrong thing and would fail well-configured servers.',
  },
  {
    id: 'R-5321-3.9-b',
    section: '3.9',
    page: 31,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When a message is delivered or forwarded to each address of an expanded ' +
      'list form, the return address in the envelope ("MAIL FROM:") MUST be ' +
      'changed to be the address of a person or other entity who administers ' +
      'the list.',
    testability: {
      kind: 'not-testable',
      reason:
        'The rewritten MAIL FROM appears only in the expander\'s OUTBOUND ' +
        'envelope to the next hop. We are the inbound client; that envelope ' +
        'is never on our socket. Would need a receiving sink downstream of ' +
        'the list, plus a list to be a member of — a different tool.',
    },
    note:
      'Scoped to the LIST model only — "an expanded list form". §3.9.1 says ' +
      'alias expansion leaves the rest of the envelope unchanged, so this MUST ' +
      'does not reach aliases; a test author skimming §3.9 as one block will ' +
      'get that backwards. The distinction is restated at R-5321-3.9.2-b, ' +
      'which the RFC itself calls "the key difference". ' +
      'Kept in the register despite being unreachable: it is one of only two ' +
      'unqualified MUSTs in the whole of §3.9, and deleting it would flatter ' +
      'the denominator exactly where the RFC is strictest. Revisit if task ' +
      '#12 ever grows an outbound sink.',
  },
  {
    id: 'R-5321-3.9-c',
    section: '3.9',
    page: 31,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, in this case, the message header section (RFC 5322 [4]) MUST ' +
      'be left unchanged; in particular, the "From" field of the header ' +
      'section is unaffected.',
    testability: {
      kind: 'not-testable',
      reason:
        'Header preservation is visible only in the message as delivered ' +
        'downstream of the expander, never in the reply codes we read. Same ' +
        'class as R-5321-2.4-d (local-part case preservation).',
    },
    note:
      'Split from R-5321-3.9-b even though it is the same sentence pair, ' +
      'because it binds a different object: b rewrites the envelope, c ' +
      'freezes the header. Together they are the envelope/header separation ' +
      'that §3.9.2 later leans on. Quoted with the "[4]" reference marker as ' +
      'printed. ' +
      'Real-world tension worth flagging: DMARC-motivated From: rewriting by ' +
      'mailing lists (the "munging" that RFC 7960 documents) violates this ' +
      'MUST head-on and is now near-universal deployed practice. §3.9.2\'s ' +
      'closing paragraph is the escape — a list that rewrites headers "need ' +
      'to be viewed as full MUAs" (R-5321-3.9.2-c) and is therefore out of ' +
      'scope of this MUST entirely. Do not record a conformance opinion here ' +
      'without that qualification.',
  },
  {
    id: 'R-5321-3.9-d',
    section: '3.9',
    page: 31,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Servers SHOULD simply utilize the addresses on the list;',
    testability: {
      kind: 'not-testable',
      reason:
        'Which addresses an exploder actually delivered to is downstream ' +
        'state. From the client side, a message accepted for a pseudo-mailbox ' +
        'gives one reply code regardless of how many list members it reached.',
    },
    note:
      'Quoted with its trailing semicolon: the clause after it is registered ' +
      'separately as R-5321-3.9-e because it has different normative force ' +
      '("strongly discouraged" prose, not a keyword) even though it sits in ' +
      'the same sentence.',
  },
  {
    id: 'R-5321-3.9-e',
    section: '3.9',
    page: 31,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'application of heuristics or other matching rules to eliminate some ' +
      'addresses, such as that of the originator, is strongly discouraged.',
    testability: {
      kind: 'not-testable',
      reason:
        'The suppressed delivery is a non-event downstream of the expander. ' +
        'Its absence is invisible to the client that submitted the message, ' +
        'and no reply code distinguishes it.',
    },
    note:
      '`prose`: "is strongly discouraged" carries SHOULD NOT force without ' +
      'the keyword — the same construction §2.4 uses for local-part case ' +
      'exploitation. Levelled SHOULD NOT rather than MUST NOT; "strongly" ' +
      'intensifies but does not promote it. ' +
      'The named target is real and common: suppressing the originator\'s own ' +
      'copy is the default in several list managers. The RFC is telling ' +
      'expanders not to be clever. Nothing observable follows for us.',
  },
  {
    id: 'R-5321-3.9.1-a',
    section: '3.9.1',
    page: 31,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'To expand an alias, the recipient mailer simply replaces the ' +
      'pseudo-mailbox address in the envelope with each of the expanded ' +
      'addresses in turn; the rest of the envelope and the message body are ' +
      'left unchanged.',
    testability: {
      kind: 'not-testable',
      reason:
        'Describes a rewrite performed on an envelope we never see, between ' +
        'the expander and the next hop. No wire event on our connection ' +
        'corresponds to it.',
    },
    note:
      '`prose`, and a borderline call worth stating openly: this sentence is ' +
      'framed as a definition of what alias expansion IS, not as an ' +
      'obligation. Registered anyway, at MUST, because "the rest of the ' +
      'envelope and the message body are left unchanged" is the operative ' +
      'contrast with §3.9.2 — it is what makes a mailer\'s return-path ' +
      'rewrite a LIST operation rather than an alias one, and §3.9.2 relies ' +
      'on it having force ("the key difference ... is the change to the ' +
      'backward-pointing address"). A reader who thinks this is purely ' +
      'definitional and non-binding has a defensible position; the register ' +
      'takes the other one and says so here. ' +
      'The following sentence ("The message is then delivered or forwarded to ' +
      'each expanded address.") is not registered separately — it is the ' +
      'consequence of this one, adds no distinct obligation, and would be ' +
      'padding the denominator.',
  },
  {
    id: 'R-5321-3.9.2-a',
    section: '3.9.2',
    page: 31,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'To expand a list, the recipient mailer replaces the pseudo-mailbox ' +
      'address in the envelope with each of the expanded addresses in turn.',
    testability: {
      kind: 'not-testable',
      reason:
        'A rewrite of the expander\'s outbound envelope, downstream of the ' +
        'delivery we submit. Never present on the client\'s socket.',
    },
    note:
      'Same definitional-prose judgement as R-5321-3.9.1-a; see that note. ' +
      'Note the quote is near-identical to §3.9.1\'s and must be kept short ' +
      'and distinct — "To expand a list" vs "To expand an alias" is the only ' +
      'thing separating them, and §3.9.1 has "simply" where this does not. ' +
      'Verified as a unique substring against the vendored RFC.',
  },
  {
    id: 'R-5321-3.9.2-b',
    section: '3.9.2',
    page: 31,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The return (backward-pointing) address in the envelope is changed so ' +
      'that all error messages generated by the final deliveries will be ' +
      'returned to a list administrator, not to the message originator, who ' +
      'generally has no control over the contents of the list and will ' +
      'typically find error messages annoying.',
    testability: {
      kind: 'not-testable',
      reason:
        'The rewritten return path is in the expander\'s outbound envelope, ' +
        'and the behaviour it governs — where bounces land — is a downstream ' +
        'event on a different connection days later. Unobservable from here.',
    },
    note:
      '`prose`, stated as fact ("is changed"). This is the same obligation as ' +
      'R-5321-3.9-b, restated in the list subsection; registered separately ' +
      'because the register is denominated in RFC statements, not in distinct ' +
      'obligations, and a reader auditing §3.9.2 must find it here. Any ' +
      'coverage decision should treat -3.9-b and this as one target. ' +
      'The RFC then adds: "Note that the key difference between handling ' +
      'aliases (Section 3.9.1) and forwarding (this subsection) is the change ' +
      'to the backward-pointing address in this case." Not registered — it is ' +
      'a cross-reference, not an obligation — but flag it: "forwarding" there ' +
      'means the LIST model of this subsection, despite §3.9.2\'s own opening ' +
      'sentence contrasting "redistribution" with "forwarding". The word is ' +
      'used in two opposite senses four sentences apart. Do not build a test ' +
      'on that sentence\'s vocabulary.',
  },
  {
    id: 'R-5321-3.9.2-c',
    section: '3.9.2',
    page: 32,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Such mailing lists need to be viewed as full MUAs, which accept a ' +
      'delivery and post a new message.',
    testability: {
      kind: 'not-testable',
      reason:
        'A classification rule addressed to the reader of the spec, not a ' +
        'behaviour any party performs. There is no wire event corresponding ' +
        'to viewing something as an MUA.',
    },
    note:
      'Kept precisely because it looks like it might bind something and does ' +
      'not — the R-5321-2.4-o trap ("MUST NOT be construed as authorization") ' +
      'in a different costume. "need to be viewed as" is directed at how to ' +
      'read §3.9, and §3.9 is not a testable region anyway. ' +
      'It matters despite being inert, because it is the scope boundary on ' +
      'the two MUSTs in §3.9: a list that does "additional, sometimes ' +
      'extensive, modifications" is an MUA, and R-5321-3.9-b and -3.9-c stop ' +
      'applying to it. That is the escape hatch under which every DMARC ' +
      'From:-munging list on the internet is conformant. See the note on ' +
      'R-5321-3.9-c. ' +
      'Page 32: this paragraph falls after the [Page 31] marker at line 1738. ' +
      'Quoted from "Such mailing lists" rather than including the preceding ' +
      '"There exist mailing lists that perform additional, sometimes ' +
      'extensive, modifications to a message and its envelope." — that ' +
      'sentence is an observation about the world with no normative force.',
  },
] as const satisfies readonly RequirementDef[];
