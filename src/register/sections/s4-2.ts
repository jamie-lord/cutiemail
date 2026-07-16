/**
 * RFC 5321 §4.2 — SMTP Replies
 * RFC 5321 §4.2.1 — Reply Code Severities and Theory
 * RFC 5321 §4.2.2 — Reply Codes by Function Groups
 * RFC 5321 §4.2.3 — Reply Codes in Numeric Order
 * RFC 5321 §4.2.4 — Reply Code 502
 * RFC 5321 §4.2.5 — Reply Codes after DATA and the Subsequent <CRLF>.<CRLF>
 *
 * Verbatim quotes from spec/rfc5321.txt (lines 2546-2988). Do not paraphrase:
 * the register's `every requirement quotes RFC 5321 verbatim` test checks every
 * `text` field against the vendored RFC and will fail on drift.
 *
 * §4.2.2 and §4.2.3 produced ZERO requirements, deliberately. Both are catalogues
 * of reply codes with no keyword and no conformance statement of their own; their
 * normative force is borrowed from §4.2.1's "the reply codes must strictly follow
 * the specifications in this section" (R-5321-4.2.1-c) and §4.2's "An SMTP server
 * SHOULD send only the reply codes listed in this document" (R-5321-4.2-k).
 * Registering forty code definitions as forty requirements would inflate the
 * denominator with entries no test could ever fail. Their content is a lookup
 * table for other sections, not a rule. One thing worth carrying forward: the two
 * lists DISAGREE. §4.2.2 prints 451 as "Requested action aborted: error in
 * processing"; §4.2.3 prints it as "Requested action aborted: local error in
 * processing". A test that pins reply text would have to pick one. It should pin
 * neither — see R-5321-4.2-l.
 *
 * Convention taken on lowercase keywords: §1.3 says only the capitalised terms are
 * conformance requirements. So the lowercase "may examine the second digit", "The
 * SMTP client should send another command", and "The sender should return to the
 * beginning of the command sequence" in §4.2.1 are NOT registered — they are
 * exposition of the code taxonomy, describing how a client might reason, not rules
 * it must follow. Lowercase statements that bind the RECEIVER's observable wire
 * behaviour ("the reply codes must strictly follow", "the complete text must be
 * marked") ARE registered, as `prose`, because they have the force of a rule
 * whatever their casing. That line is a judgement call and it is drawn here so a
 * reader can argue with it.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_2 = [
  {
    id: 'R-5321-4.2-a',
    section: '4.2',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Every command MUST generate exactly one reply.',
    testability: { kind: 'wire' },
    note:
      'The load-bearing sentence of the whole section, and the anti-smuggling ' +
      'invariant: "exactly one" fails in BOTH directions. Zero replies is the ' +
      'obvious failure; TWO replies to one command is the interesting one, and it ' +
      'is how response-injection lands. Test by pipelining a known command count ' +
      'and asserting the reply count matches exactly — not merely that the last ' +
      'reply looks right. ' +
      'TRAP: a multiline reply is ONE reply, not N. A counter that counts lines ' +
      'rather than reply-terminating lines (code followed by <SP> or bare CRLF, ' +
      'per R-5321-4.2.1-f) will fail every server that greets with a banner and an ' +
      'EHLO capability list. ' +
      'Second trap: 421 is exempt in practice — §4.2.2 says it "may be a reply to ' +
      'any command if the service knows it must shut down", so a 421 arriving ' +
      'unbidden is not a second reply to the previous command. And the DATA phase ' +
      'is a command sequence group: DATA gets 354, the <CRLF>.<CRLF> gets its own ' +
      'reply, and the message content in between gets none. Counting octets sent ' +
      'as commands during DATA is the classic way to write this test wrong.',
  },
  {
    id: 'R-5321-4.2-b',
    section: '4.2',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'An SMTP reply consists of a three digit number (transmitted as three ' +
      'numeric characters) followed by some text unless specified otherwise in ' +
      'this document.',
    testability: { kind: 'wire' },
    note:
      'Stated as a definition rather than with a keyword, hence `prose`. The ' +
      'three-digit half is firm and testable: assert every reply opens with ' +
      'exactly three numeric characters (not two, not four, not "250 " with a ' +
      'leading space). ' +
      'TRAP, and it is a big one: the "followed by some text" half is CONTRADICTED ' +
      'three times inside this same section. The ABNF at R-5321-4.2-i makes it ' +
      '`[ SP textstring ]` — optional. R-5321-4.2-o downgrades omission to a mere ' +
      'SHOULD NOT. R-5321-4.2-n says "any text, including no text at all ... MUST ' +
      'be acceptable". Only the sentence at R-5321-4.2-e calls omission "in ' +
      'violation of this specification". A bare `250\\r\\n` is therefore NOT a ' +
      'failure and a test must not treat it as one; the honest level for the text ' +
      'half is the SHOULD NOT of R-5321-4.2-o. This entry keeps the MUST because ' +
      'that is what the sentence says, and records that the section overrides ' +
      'itself. Consistent with the existing note on R-5321-2.3.7-b, which reaches ' +
      'the same conclusion from §2.3.7. 5321bis is the place to resolve this.',
  },
  {
    id: 'R-5321-4.2-c',
    section: '4.2',
    page: 46,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'In particular, the 220, 221, 251, 421, and 551 reply codes are associated ' +
      'with message text that must be parsed and interpreted by machines.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'One recipient that produces 251 and one that produces 551 (both require ' +
        'a forwarding configuration we cannot create in-band), plus a way to ' +
        'provoke 421. Only 220 and 221 are reachable on a bare connection.',
    },
    note:
      'Registered as `prose` because the sentence is framed as an observation ' +
      '("are associated with") but carries a real obligation on both sides: the ' +
      'server must SUPPLY machine-parsable text in these five replies, and the ' +
      'client must parse it. It is the named exception to R-5321-4.2-m ("determine ' +
      'its actions only by the reply code"). ' +
      'TRAP: the sentence does not say what the text must contain — the shapes ' +
      'live elsewhere (§4.2.2 gives "<domain>" for 220/221/421, §3.4 gives ' +
      '<forward-path> for 251/551). Do not invent a grammar here. The only piece ' +
      'testable without fixtures is the 220 greeting, and its syntax is already ' +
      'R-5321-4.2-g, which is the entry to assert against. This one is close to ' +
      'redundant on the wire and is registered for the denominator.',
  },
  {
    id: 'R-5321-4.2-d',
    section: '4.2',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Formally, a reply is defined to be the sequence: a three-digit code, <SP>, ' +
      'one line of text, and <CRLF>, or a multiline reply (as defined in the same ' +
      'section).',
    testability: { kind: 'wire' },
    note:
      'Registered separately from R-5321-4.2-b because it does different work: -b ' +
      'says a reply has a code and text, this says a reply is ONE LINE terminated ' +
      'by <CRLF> unless it uses the multiline form. That is the testable part — a ' +
      'reply must not contain a bare LF or CR, and must not run to a second line ' +
      'without the "code-" continuation marker. ' +
      'TRAP: "<SP>, one line of text" is again stricter than the ABNF that follows ' +
      'it eight lines later, which makes both optional. Same contradiction as -b; ' +
      'assert the <CRLF> framing, not the mandatory space-and-text.',
  },
  {
    id: 'R-5321-4.2-e',
    section: '4.2',
    page: 46,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Since, in violation of this specification, the text is sometimes not sent, ' +
      'clients that do not receive it SHOULD be prepared to process the code ' +
      'alone (with or without a trailing space character).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our own client parser, not the server under test. Nothing the ' +
        'server does reveals whether we took the permission.',
    },
    note:
      'Our client MUST take this SHOULD, or the suite is unusable against real ' +
      'servers: it must accept `250\\r\\n`, `250 \\r\\n` and `250 OK\\r\\n` as the ' +
      'same reply. Note the subclause "with or without a trailing space" — a ' +
      'parser that splits on " " and requires a second field breaks on the first ' +
      'of those and, worse, may swallow the second as an empty-text reply it ' +
      'reports differently. Test our parser against all three. ' +
      'This is the ONLY place in §4.2 that calls text omission a violation, and ' +
      'it does so in a subordinate clause justifying a client SHOULD — thin ground ' +
      'to fail a server on. See the note on R-5321-4.2-b.',
  },
  {
    id: 'R-5321-4.2-f',
    section: '4.2',
    page: 46,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Only the EHLO, EXPN, and HELP commands are expected to result in multiline ' +
      'replies in normal circumstances; however, multiline replies are allowed ' +
      'for any command.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission with no failing branch, and we cannot compel a server to ' +
        'send a multiline reply to a command of our choosing. Its real force is ' +
        'a constraint on our own parser.',
    },
    note:
      'Text spans the page 46/47 boundary; quoted continuously and filed under the ' +
      'page it starts on. ' +
      'TRAP, and this is why the entry earns its place despite being untestable: ' +
      '"allowed for any command" forbids a very tempting test design. Do not ' +
      'special-case multiline parsing to EHLO/EXPN/HELP. A server may legally ' +
      'answer MAIL FROM, RCPT TO, the end of DATA, or QUIT with a multiline reply, ' +
      'and several do (Exim emits multiline 550s with policy explanations). A ' +
      'parser that reads exactly one line after RCPT TO will desynchronise against ' +
      'those servers and then report a cascade of phantom failures in every later ' +
      'assertion — a suite bug that would look exactly like a server bug. ' +
      '"expected ... in normal circumstances" is description, not permission; the ' +
      '"however" clause is the normative half.',
  },
  {
    id: 'R-5321-4.2-g',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Greeting       = ( "220 " (Domain / address-literal) ' +
      '[ SP textstring ] CRLF ) / ' +
      '( "220-" (Domain / address-literal) ' +
      '[ SP textstring ] CRLF ' +
      '*( "220-" [ textstring ] CRLF ) ' +
      '"220" [ SP textstring ] CRLF )',
    testability: { kind: 'wire' },
    note:
      'ABNF, registered as `prose` — it is introduced by "In ABNF, server ' +
      'responses are:", which makes it a definition of conforming server output, ' +
      'not illustration. Cheapest high-value test in the section: connect, read ' +
      'the greeting, assert it starts "220 " or "220-" and that the FIRST token ' +
      'after the code is a Domain or address-literal. Servers that greet with ' +
      '"220 ESMTP Postfix" (no domain) are in violation, and it is common enough ' +
      'that this test will find something. ' +
      'TRAP 1: the last line of the multiline form is `"220" [ SP textstring ]` — ' +
      'note "220" with NO trailing space in the literal, so `220\\r\\n` terminates ' +
      'a multiline greeting legally. ' +
      'TRAP 2: the domain appears only on the FIRST line of the multiline form. Do ' +
      'not look for it on the terminating line. ' +
      'TRAP 3, the one that will bite: this production applies ONLY to 220. The ' +
      'RFC says so immediately below — "where \'Greeting\' appears only in the 220 ' +
      'response that announces that the server is opening its part of the ' +
      'connection. (Other possible server responses upon connection follow the ' +
      'syntax of Reply-line.)" So a server refusing the connection with `554 No ' +
      'SMTP service here` or `421 Too many connections` is under Reply-line and ' +
      'owes us no domain. Asserting "the connect reply contains a domain" fails ' +
      'those servers wrongly. Gate the assertion on the code being 220.',
  },
  {
    id: 'R-5321-4.2-h',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'textstring     = 1*(%d09 / %d32-126) ; HT, SP, Printable US-ASCII',
    testability: { kind: 'wire' },
    note:
      'ABNF, `prose` for the reason given on R-5321-4.2-g. Quietly one of the most ' +
      'testable rules in the section and one nobody thinks to test: reply text is ' +
      'restricted to HT (%d09) and printable US-ASCII (%d32-126). Everything else ' +
      'is excluded — no CR, no LF, no NUL, no control characters, and no octet ' +
      'with the high bit set. Assert it on every reply we ever read, as a blanket ' +
      'invariant rather than a single test. ' +
      'Expect real findings: servers that interpolate a HELO argument, a rejected ' +
      'address, or an antivirus verdict into reply text will happily emit UTF-8 or ' +
      'raw 8-bit octets there. That is a genuine violation absent SMTPUTF8 ' +
      '(RFC 6531 relaxes it for reply text; that is task #19 territory, and the ' +
      'assertion must be skipped once SMTPUTF8 is negotiated). ' +
      'TRAP: `1*` means textstring is one-or-more — an EMPTY textstring does not ' +
      'match. That does NOT make `250 \\r\\n` illegal: Reply-line brackets the ' +
      'whole `[ SP textstring ]` group, so the space-with-no-text case is instead ' +
      'the SP-without-textstring reading permitted by R-5321-4.2-o and the ' +
      '"with or without a trailing space" of R-5321-4.2-e. Do not fail it.',
  },
  {
    id: 'R-5321-4.2-i',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Reply-line     = *( Reply-code "-" [ textstring ] CRLF ) ' +
      'Reply-code [ SP textstring ] CRLF',
    testability: { kind: 'wire' },
    note:
      'ABNF, `prose` per R-5321-4.2-g. This is the authoritative reply grammar and ' +
      'the one to build the parser from — it, not the prose above it, is what ' +
      'servers implement. Note what it permits that the prose forbids: `[ SP ' +
      'textstring ]` is optional in full, so `250\\r\\n` conforms. That optionality ' +
      'is the resolution of the contradiction flagged on R-5321-4.2-b. ' +
      'Note also `*(...)` — zero or more continuation lines — so a single-line ' +
      'reply is just the degenerate multiline reply. One code path, not two. ' +
      'Related, and folded in here rather than registered separately because it ' +
      'is a definition and not a rule: "The space (blank) following the reply code ' +
      'is considered part of the text." That is why SP and textstring are bracketed ' +
      'together, and why R-5321-4.2-n\'s "any text, including no text at all" ' +
      'reaches the space too. ' +
      'TRAP: continuation lines use `[ textstring ]` with NO SP after the hyphen — ' +
      '"250-" is a legal continuation line and the hyphen is not part of the text. ' +
      'A parser slicing a fixed 4 characters off every line silently eats the first ' +
      'character of text on a line like "250-234 Text beginning with numbers", the ' +
      'RFC\'s own example at §4.2.1.',
  },
  {
    id: 'R-5321-4.2-j',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'Reply-code     = %x32-35 %x30-35 %x30-39',
    testability: { kind: 'wire' },
    note:
      'ABNF, `prose` per R-5321-4.2-g. Reads: first digit 2-5, SECOND DIGIT 0-5, ' +
      'third digit 0-9. The first-digit restriction is restated with a keyword at ' +
      'R-5321-4.2-s, which is the entry a test should cite for that half — it is ' +
      'unambiguous and carries the "in the absence of extensions" caveat. ' +
      'TRAP, and the reason this is registered separately from -s: the SECOND ' +
      'digit restriction to 0-5 exists ONLY here, in the ABNF, with no prose ' +
      'anywhere and no keyword. It follows from §4.2.1\'s x0z-x5z categories (x3z ' +
      'and x4z are "Unspecified", but they exist), and it means a reply like 260 ' +
      'or 471 is ungrammatical. Before writing a test on it, be aware that this is ' +
      'a stricter reading than most implementers hold and that failing a server on ' +
      'an ABNF byte range no prose backs is how a conformance suite loses ' +
      'credibility. Report it, do not fail on it, unless 5321bis firms it up.',
    deliberatelyUncovered: {
      reason:
        'the UNIQUE content of this entry over R-5321-4.2-s is the second-digit 0-5 restriction, which exists only in the §4.2 ABNF with no prose and no keyword anywhere in RFC 5321. Convicting a server (a MUST + `violated` is a finding with no escape) on that byte range would be a false positive against the many conforming-in-practice servers that never intended the ABNF that strictly, and 5321bis has not firmed it up (see docs/decisions/0004). The first-digit half IS covered, via R-5321-4.2-s. This is an observe-not-convict decision, exactly as the note prescribes ("Report it, do not fail on it").',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.2-k',
    section: '4.2',
    page: 47,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'An SMTP server SHOULD send only the reply codes listed in this document.',
    testability: { kind: 'wire' },
    note:
      'Testable as a blanket invariant over every reply we collect: is the code in ' +
      'the §4.2.3 list? SHOULD, so a miss is `permitted-latitude`, never failure. ' +
      'TRAP: "listed in this document" is wider than §4.2.3. Codes appear in §4.3.2 ' +
      'and §4.5.3.1 too, and R-5321-4.2-q explicitly says the list "MUST NOT be ' +
      'construed as permanent" — extensions add codes legitimately. The whitelist ' +
      'must be built from the whole RFC plus whatever the server advertised in ' +
      'EHLO, not from §4.2.3 alone, or this fires constantly on servers doing ' +
      'nothing wrong. Given that, the honest posture is to record the unlisted ' +
      'code and let a human read it.',
  },
  {
    id: 'R-5321-4.2-l',
    section: '4.2',
    page: 47,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'An SMTP server SHOULD use the text shown in the examples whenever appropriate.',
    testability: {
      kind: 'not-testable',
      reason:
        '"whenever appropriate" has no failing case — the server decides what is ' +
        'appropriate, so no observation can contradict it. §4.2.1 also says "Each ' +
        'reply text is recommended rather than mandatory, and may even change ' +
        'according to the command with which it is associated", which withdraws ' +
        'the obligation outright.',
    },
    note:
      'Kept because it looks like a free win and is a trap. It is the only sentence ' +
      'that could motivate asserting reply TEXT, and asserting reply text is the ' +
      'single fastest way to make this suite worthless: essentially no deployed ' +
      'server says "Requested mail action okay, completed", they all say "OK" or ' +
      '"2.0.0 Ok: queued as 4B2C1". They are all conforming. ' +
      'Reinforced by the register-level observation that the RFC cannot even quote ' +
      'itself consistently — §4.2.2 and §4.2.3 print different text for 451 (see ' +
      'the module header). If the document disagrees with itself about the example ' +
      'text, the example text is not assertable.',
  },
  {
    id: 'R-5321-4.2-m',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'An SMTP client MUST determine its actions only by the reply code, not by ' +
      'the text (except for the "change of address" 251 and 551 and, if ' +
      'necessary, 220, 221, and 421 replies);',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client. No server observation reveals what our code branched ' +
        'on. It is an architectural constraint on the suite, not an assertion.',
    },
    note:
      'Quoted with its trailing semicolon; the clause after it (R-5321-4.2-n) is a ' +
      'separate requirement. ' +
      'This one should be read as a design rule for the suite and enforced by ' +
      'review, not by a test: no expectation may match on reply text. The five ' +
      'exempt codes are the same five as R-5321-4.2-c, and note the asymmetry — ' +
      '251/551 are unconditional exceptions, 220/221/421 only "if necessary". ' +
      'Even for those, prefer the code. If a reviewer finds a text match anywhere ' +
      'outside the greeting-domain check of R-5321-4.2-g, it is a bug in us.',
  },
  {
    id: 'R-5321-4.2-n',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'in the general case, any text, including no text at all (although senders ' +
      'SHOULD NOT send bare codes), MUST be acceptable.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client parser. The server cannot show us whether we accepted ' +
        'its text; only our own crash would.',
    },
    note:
      'The clearest statement in the RFC that a bare code is acceptable, and the ' +
      'reason R-5321-4.2-b\'s "followed by some text" cannot be enforced. Quoted ' +
      'whole, INCLUDING the parenthetical, because the parenthetical is what fixes ' +
      'the level of the server-side rule; that rule is registered separately as ' +
      'R-5321-4.2-o since it binds the other party. The two entries deliberately ' +
      'overlap in text. ' +
      'Fuzz our parser against 250 with no text, 250 with 512 octets of text, and ' +
      '250 with text that is itself a valid-looking reply line.',
  },
  {
    id: 'R-5321-4.2-o',
    section: '4.2',
    page: 47,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: '(although senders SHOULD NOT send bare codes)',
    testability: { kind: 'wire' },
    note:
      'Split out of R-5321-4.2-n because "senders" here means the sender of the ' +
      'REPLY — the server — while the MUST around it binds the client. Quoted with ' +
      'its parentheses to keep it a unique substring; "SHOULD NOT send bare codes" ' +
      'alone is short enough to be worth the extra characters. ' +
      'This is the true, and only, normative level of the "replies carry text" ' +
      'rule: SHOULD NOT, not the MUST that R-5321-4.2-b and R-5321-4.2-e imply. ' +
      'Testable — a bare `250\\r\\n` from the server is observable — and the ' +
      'outcome is `permitted-latitude`, never a failure. ' +
      'TRAP: "bare code" is not defined. Is `250 \\r\\n` (code, space, nothing) ' +
      'bare? R-5321-4.2-e\'s "with or without a trailing space character" treats ' +
      'both as the same case, and R-5321-4.2.1-g positively asks servers to send ' +
      'the <SP> when text is absent — so a server sending `250 \\r\\n` is doing ' +
      'exactly what it was told and must not be flagged here. Flag only a code ' +
      'with no SP and no text.',
  },
  {
    id: 'R-5321-4.2-p',
    section: '4.2',
    page: 47,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Whenever possible, a receiver-SMTP SHOULD test the first digit (severity ' +
      'indication) of the reply code.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds whichever party actually reads replies, and no observation from a ' +
        'socket reveals which digit the peer examined.',
    },
    note:
      'Registered `party: client` against the letter of the text, and this is a ' +
      'judgement worth flagging. The RFC says "receiver-SMTP", but replies are ' +
      'received by the CLIENT, and the whole paragraph — "An SMTP client MUST ' +
      'determine its actions only by the reply code" — is about clients. Reading ' +
      'this as binding the server would require the server to test the first digit ' +
      'of its own reply, which is incoherent. It is an editing scar from RFC 821, ' +
      'where "receiver-SMTP" and "sender-SMTP" were used inconsistently; §4.2 ' +
      'switches between "sender-SMTP" and "SMTP client" within four paragraphs. ' +
      'Filed as `client` and flagged rather than silently normalised.',
  },
  {
    id: 'R-5321-4.2-q',
    section: '4.2',
    page: 47,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The list of codes that appears below MUST NOT be construed as permanent.',
    testability: {
      kind: 'not-testable',
      reason:
        'A rule about how to READ the document, not a behaviour either party ' +
        'performs. There is no wire event corresponding to construing a list as ' +
        'permanent — the same shape as R-5321-2.4-o.',
    },
    note:
      'Untestable, but it constrains the tests we may write, which is why it must ' +
      'not be dropped: it is the RFC pre-emptively forbidding a closed whitelist ' +
      'of reply codes. Any test that fails a server for an unrecognised code is ' +
      'construing the list as permanent and violating this. See the note on ' +
      'R-5321-4.2-k, which is the entry this constrains. ' +
      'The following sentence — "new codes may be added as the result of new ' +
      'Standards or Standards-Track specifications" — is IETF process, binding no ' +
      'implementation, and is not registered.',
  },
  {
    id: 'R-5321-4.2-r',
    section: '4.2',
    page: 47,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Consequently, a sender-SMTP MUST be prepared to handle codes not specified ' +
      'in this document and MUST do so by interpreting the first digit only.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client. Whether we interpreted only the first digit of an ' +
        'unknown code is invisible to the server.',
    },
    note:
      'Two MUSTs in one sentence but a single entry: same party, same testability, ' +
      'and the second is the method for the first — splitting would be ceremony. ' +
      'A direct requirement on the suite\'s architecture. Our expectation model ' +
      '(task #9) must have a first-digit-only fallback for codes it does not know, ' +
      'and it must not throw. Worth a unit test against a synthetic `269` and a ' +
      '`4yz` we never registered: the client should treat them as 2yz-success and ' +
      '4yz-transient respectively and carry on.',
  },
  {
    id: 'R-5321-4.2-s',
    section: '4.2',
    page: 47,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In the absence of extensions negotiated with the client, SMTP servers MUST ' +
      'NOT send reply codes whose first digits are other than 2, 3, 4, or 5.',
    testability: { kind: 'wire' },
    note:
      'Text spans the page 47/48 boundary; filed under the page it starts on. ' +
      'The strongest cheaply-testable rule in the section, and unlike ' +
      'R-5321-4.2-k it is a MUST NOT with a clean failing case. Apply as a blanket ' +
      'invariant on every reply: first digit in [2,3,4,5]. A 1yz reply is the ' +
      'expected catch — §4.2.1 says "FTP\'s 1yz codes are not part of the SMTP ' +
      'model", and an FTP-derived or hand-rolled server can leak one. ' +
      'TRAP: "In the absence of extensions negotiated with the client" is a real ' +
      'escape hatch, so the invariant is only unconditional before EHLO succeeds. ' +
      'After EHLO, a server advertising an extension that defines other first ' +
      'digits is conforming. No registered extension does this today, so treat a ' +
      '1yz/6yz-plus as failure regardless, but record which extensions were ' +
      'advertised so the finding can be defended.',
  },
  {
    id: 'R-5321-4.2-t',
    section: '4.2',
    page: 48,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Clients that receive such out-of-range codes SHOULD normally treat them as ' +
      'fatal errors and terminate the mail transaction.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client. We would have to be talking to a server that violates ' +
        'R-5321-4.2-s to exercise it, and even then the requirement is on our ' +
        'reaction, not the server\'s.',
    },
    note:
      'Our client should NOT take this SHOULD literally. "Terminate the mail ' +
      'transaction" is right for a mail client; for a conformance suite it would ' +
      'destroy the evidence — we want to record the violation of R-5321-4.2-s, ' +
      'continue, and see what else the server does. "SHOULD normally" is doubly ' +
      'hedged, so declining is well within the latitude. Record the deviation as a ' +
      'deliberate suite decision if anyone asks.',
  },

  {
    id: 'R-5321-4.2.1-a',
    section: '4.2.1',
    page: 48,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'Each reply in this category might have a different time value, but the SMTP client SHOULD try again.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client, and retry behaviour after a 4yz is a queue-manager ' +
        'concern this suite does not have. The server cannot observe whether we ' +
        'intend to retry.',
    },
    note:
      'Quoted with the preceding clause ("Each reply in this category might have a ' +
      'different time value, but") because "the SMTP client SHOULD try again" is ' +
      'too short to be a safely unique substring of the RFC. ' +
      'The suite should NOT retry on 4yz — a retry loop would turn one transient ' +
      'reply into repeated load on a stranger\'s server, and the 4yz itself is the ' +
      'observation we wanted. This is a case where conforming to the RFC as a mail ' +
      'client and behaving well as a test tool point in opposite directions.',
  },
  {
    id: 'R-5321-4.2.1-b',
    section: '4.2.1',
    page: 48,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The SMTP client SHOULD NOT repeat the exact request (in the same sequence).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client. Repeating a request after a 5yz is visible to the ' +
        'server, but the requirement is on us, so there is nothing to assert ' +
        'about the server under test.',
    },
    note:
      'The sentence sits inside the 5yz definition, whose text runs across the ' +
      'page 48/49 boundary; the quoted line itself is on page 48. ' +
      'This one the suite may legitimately violate on purpose: re-sending a ' +
      'command that drew a 5yz is a reasonable probe (does the server give the ' +
      'same code twice? does it start counting toward an error limit, per §4.3.2?). ' +
      'Same posture as R-5321-2.4-g in the exemplar — we break client rules ' +
      'deliberately to observe the server. Just do not do it inside a transaction ' +
      'we still need.',
  },
  {
    id: 'R-5321-4.2.1-c',
    section: '4.2.1',
    page: 49,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'On the other hand, the reply codes must strictly follow the specifications in this section.',
    testability: {
      kind: 'not-testable',
      reason:
        'Too abstract to assert directly: "the specifications in this section" is ' +
        'the whole severity/category taxonomy, and judging whether a server picked ' +
        'the semantically right code for a situation needs to know its internal ' +
        'reason for replying, which we never do.',
    },
    note:
      'Lowercase "must", hence `prose` — §1.3 reserves conformance force to the ' +
      'capitalised terms, but this sentence is unambiguously a rule and is set up ' +
      'by an explicit contrast: "Each reply text is recommended rather than ' +
      'mandatory ... On the other hand, the reply codes must strictly follow". The ' +
      'whole point of the sentence is that codes bind where text does not. ' +
      'This is the sentence that gives §4.2.2 and §4.2.3 their normative force, ' +
      'which is why those sections have no entries of their own. ' +
      'Marked not-testable deliberately, and it is the judgement most likely to be ' +
      'challenged. Its consequences ARE testable one at a time and are registered ' +
      'where they are stated concretely — R-5321-4.2-j (code grammar), ' +
      'R-5321-4.2-s (first digit), R-5321-4.2.4-a/b (502 vs 500). Do not build a ' +
      '"code is semantically correct" test on this; there is no such assertion.',
  },
  {
    id: 'R-5321-4.2.1-d',
    section: '4.2.1',
    page: 49,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Receiver implementations should not invent new codes for slightly ' +
      'different situations from the ones described here, but rather adapt codes ' +
      'already defined.',
    testability: { kind: 'wire' },
    note:
      'Lowercase "should not", hence `prose`; the force is a plain SHOULD NOT and ' +
      'it names the bound party outright ("Receiver implementations"), which is ' +
      'unusual enough for this section to be worth trusting. ' +
      'Weakly testable, and only in the same shape as R-5321-4.2-k: a code outside ' +
      'the RFC\'s lists is the observable proxy for "invented". ' +
      'TRAP: it is a poor proxy. We cannot tell an invented code from an extension ' +
      'code, and R-5321-4.2-q forbids treating the list as closed. Worse, the ' +
      '"slightly different situations" qualifier means a server inventing a code ' +
      'for a genuinely NEW situation is not caught by this sentence at all. ' +
      'Report, never fail. Almost certainly redundant with R-5321-4.2-k on the ' +
      'wire — a candidate for deliberate non-coverage after one run.',
  },
  {
    id: 'R-5321-4.2.1-e',
    section: '4.2.1',
    page: 50,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The reply text may be longer than a single line; in these cases the ' +
      'complete text must be marked so the SMTP client knows when it can stop ' +
      'reading the reply.',
    testability: { kind: 'wire' },
    note:
      'Lowercase "must", hence `prose`. Registered despite reading like exposition ' +
      'because it states the actual obligation that the format rule below ' +
      '(R-5321-4.2.1-f) merely implements: a multiline reply must be terminable. ' +
      'The testable consequence is real and security-relevant: a reply must ' +
      'eventually produce a terminating line. A server that emits continuation ' +
      'lines without end has violated this, and our reader needs a line-count and ' +
      'octet bound so that case is a finding rather than a hang. Give it one. ' +
      '§4.5.3.1.5 bounds the reply LINE at 512 octets but bounds nothing about the ' +
      'number of lines, so the bound we pick is ours, not the RFC\'s — report it ' +
      'as "no terminating line within N", not as an RFC violation of a limit that ' +
      'does not exist.',
    deliberatelyUncovered: {
      reason:
        'the ONLY wire-observable failure of "a multiline reply must be terminable" is a reply whose continuation never ends — which reaches our reader as bytes that never frame, i.e. a TIMEOUT. The project\'s ironclad rule is timeout -> inconclusive, never a finding (§4.5.3.2 permits minutes; a slow server is not a broken one). Any standalone conviction here would therefore either convict on a timeout (forbidden) or desync silently, and the "no terminating line within N" bound is ours, not the RFC\'s. reply-structure.ts already records this as deliberate non-coverage in prose; this encodes it. The concretely-convictable multiline slices (same code per line, well-formed separator) live in R-5321-4.2.1-f / -i.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-4.2.1-f',
    section: '4.2.1',
    page: 50,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The format for multiline replies requires that every line, except the ' +
      'last, begin with the reply code, followed immediately by a hyphen, "-" ' +
      '(also known as minus), followed by text.  The last line will begin with ' +
      'the reply code, followed immediately by <SP>, optionally some text, and ' +
      '<CRLF>.',
    testability: { kind: 'wire' },
    note:
      '`prose`: "requires that" and "will begin" carry MUST force without the ' +
      'keyword — this is the definition of the multiline format, and the ABNF ' +
      'Reply-line (R-5321-4.2-i) says the same thing formally. Registered ' +
      'separately from the ABNF because it is where the prose states it and ' +
      'because it adds "followed IMMEDIATELY by", which the ABNF cannot express as ' +
      'emphatically. ' +
      'Directly testable against any EHLO response: every non-final line matches ' +
      '`^\\d{3}-`, the final line matches `^\\d{3}( |$)`. ' +
      'TRAP: "followed immediately" is the whole game. `250 -text` is not a ' +
      'continuation line, it is a final line whose text begins with a hyphen. A ' +
      'lenient parser that strips whitespace before checking for the hyphen will ' +
      'hang forever waiting for a terminator that already arrived. Do not be ' +
      'lenient here. ' +
      'Second trap: this sentence says the last line is "followed immediately by ' +
      '<SP>" — mandatory — while R-5321-4.2-i\'s ABNF brackets it and ' +
      'R-5321-4.2.1-g reduces it to SHOULD. Same contradiction as R-5321-4.2-b. ' +
      'Accept a bare `250\\r\\n` as a terminating line.',
  },
  {
    id: 'R-5321-4.2.1-g',
    section: '4.2.1',
    page: 50,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'As noted above, servers SHOULD send the <SP> if subsequent text is not sent,',
    testability: { kind: 'wire' },
    note:
      'Split from the clause that follows (R-5321-4.2.1-h) because that half binds ' +
      'the client; quoted with its trailing comma. ' +
      'Testable and easy: whenever a reply has no text, did the server still send ' +
      'the space? Outcome is `permitted-latitude` either way. ' +
      'This is the sentence that resolves what R-5321-4.2-o means by "bare code": ' +
      'the RFC would rather have `250 \\r\\n` than `250\\r\\n`. In practice ' +
      'neither is common and this will be untriggered against most servers — a ' +
      'reasonable candidate for deliberate non-coverage. Note "As noted above" ' +
      'refers back to R-5321-4.2-e; the two are the same rule stated twice, from ' +
      'each side.',
  },
  {
    id: 'R-5321-4.2.1-h',
    section: '4.2.1',
    page: 50,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'but clients MUST be prepared for it to be omitted.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client parser. A server cannot observe whether we coped with a ' +
        'missing space; only our own failure to parse would show it.',
    },
    note:
      'The mirror of R-5321-4.2.1-g and, unlike it, a hard MUST — the asymmetry is ' +
      'deliberate and is Postel\'s principle in one sentence. Our reply parser ' +
      'must treat the SP as optional in BOTH the terminating-line check and the ' +
      'text extraction. Note the consequence for R-5321-4.2.1-f\'s regex: a ' +
      'terminating line is `^\\d{3}` followed by SP OR end-of-line, and the ' +
      'end-of-line branch is the one this MUST exists to protect. Unit-test it.',
  },
  {
    id: 'R-5321-4.2.1-i',
    section: '4.2.1',
    page: 50,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'In a multiline reply, the reply code on each of the lines MUST be the same.',
    testability: { kind: 'wire' },
    note:
      'Clean MUST, cheap test, and worth running against every multiline reply we ' +
      'see: collect the codes from all lines of a reply and assert the set has one ' +
      'element. EHLO gives us one for free on every connection. ' +
      'TRAP: the RFC\'s own example immediately above is "250-234 Text beginning ' +
      'with numbers", a line whose TEXT starts with three digits. An extractor ' +
      'that regexes `\\d{3}` anywhere in the line, or that re-scans after the ' +
      'hyphen, will read 234 as a mismatched code and report a false failure on ' +
      'entirely conforming output. Anchor to the start of the line. The RFC put ' +
      'that example there on purpose. ' +
      'The following sentence — "It is reasonable for the client to rely on this, ' +
      'so it can make processing decisions based on the code in any line" — is ' +
      'the rationale, not a separate requirement, and is not registered.',
  },

  {
    id: 'R-5321-4.2.4-a',
    section: '4.2.4',
    page: 53,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      '502 SHOULD be used when the command is actually recognized by the SMTP ' +
      'server, but not implemented.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A command the server under test recognises but has not implemented. This ' +
        'is server-specific knowledge we cannot obtain in-band — the whole point ' +
        'of the distinction is internal to the implementation. Best available ' +
        'proxies: VRFY, EXPN, HELP and TURN, which many servers know of and ' +
        'decline to implement.',
    },
    note:
      'The 502-vs-500 distinction turns on whether the server RECOGNISES the ' +
      'command, which is a fact about its parser that no probe can establish. We ' +
      'can send VRFY and see 502; we cannot prove the server would have been ' +
      'entitled to 500 instead. So the fixture is really "a server whose ' +
      'unimplemented-command list we know out of band". ' +
      'TRAP: 252 is the other legal answer to VRFY (§3.5.3), and 502 for VRFY is ' +
      'explicitly discussed as controversial elsewhere in the RFC. Do not build ' +
      'the canonical test of this requirement on VRFY. ' +
      'SHOULD, so anything else is `permitted-latitude`. The pairing with ' +
      'R-5321-4.2.4-b is what makes this testable at all — see that entry, which ' +
      'is the half that needs no fixture.',
  },
  {
    id: 'R-5321-4.2.4-b',
    section: '4.2.4',
    page: 53,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the command is not recognized, code 500 SHOULD be returned.',
    testability: { kind: 'wire' },
    note:
      'The testable half of the 502/500 pair, and it needs no fixture: WE choose ' +
      'the command, so we can guarantee it is unrecognised. Send garbage no server ' +
      'can know — "ZZZZ", or a random 8-character verb — and expect 500. ' +
      'TRAP 1: an "X"-prefixed verb is the WRONG probe. §4.1.5 reserves X-commands ' +
      'for private extensions, so a server that implements XCLIENT or XFORWARD ' +
      'recognises yours by accident. Use a non-X verb. ' +
      'TRAP 2: 500 is also the code for "command line too long" (§4.2.2) and for ' +
      'invalid characters (§2.4, R-5321-2.4-l). Keep the probe short and pure ' +
      'ASCII or the observation is ambiguous. ' +
      'TRAP 3: SHOULD, so 502 for an unknown command is latitude, not failure — ' +
      'and it is extremely common, because many servers do not distinguish the two ' +
      'cases at all. Expect `permitted-latitude` from a large fraction of servers ' +
      'and do not let that be read as a bug. ' +
      'TRAP 4: this is a fine probe to send BEFORE EHLO, which crosses §4.3.2 — a ' +
      'server may answer 503 (bad sequence) instead and be right. Send it inside a ' +
      'greeted session.',
  },
  {
    id: 'R-5321-4.2.4-c',
    section: '4.2.4',
    page: 53,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Extended SMTP systems MUST NOT list capabilities in response to EHLO for ' +
      'which they will return 502 (or 500) replies.',
    testability: { kind: 'wire' },
    note:
      'The best requirement in this file: a hard MUST NOT, no fixture, and it is ' +
      'violated in the wild. Read the EHLO keyword list, then exercise each ' +
      'advertised capability and assert none draws 502 or 500. Self-describing ' +
      'servers hand us the test corpus. ' +
      'TRAP, and it is subtle: most EHLO keywords are not commands. PIPELINING, ' +
      '8BITMIME, SIZE and ENHANCEDSTATUSCODES name behaviours or MAIL/RCPT ' +
      'parameters, not verbs you can send. Only a minority (STARTTLS, AUTH, VRFY ' +
      'if advertised, ETRN, DSN in part) are directly invocable, and the parameter ' +
      'ones must be probed through MAIL FROM instead — where the wrong-answer code ' +
      'is 555 or 504, not 502, so the assertion does not transfer. Sending ' +
      '"PIPELINING" as a verb and expecting anything but 500 would be a bug in us, ' +
      'and a naive implementation of this test does exactly that. Enumerate the ' +
      'invocable keywords explicitly; do not derive them. ' +
      'Second trap: STARTTLS and AUTH legitimately answer 5yz for reasons other ' +
      'than "not implemented" — 454, 530, 538. Those are not violations. Only 502 ' +
      'and 500 are, exactly as quoted.',
  },

  {
    id: 'R-5321-4.2.5-a',
    section: '4.2.5',
    page: 53,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When an SMTP server returns a positive completion status (2yz code) after ' +
      'the DATA command is completed with <CRLF>.<CRLF>, it accepts ' +
      'responsibility for: o delivering the message (if the recipient mailbox ' +
      'exists), or',
    testability: {
      kind: 'not-testable',
      reason:
        'Delivery happens after the connection we are watching. Confirming it ' +
        'needs a receiving sink and an end-to-end path, which is a different ' +
        'tool — the same call as R-5321-2.4-d.',
    },
    note:
      'Quoted across the bullet marker: the normaliser collapses the "o  " list ' +
      'bullet and its surrounding blank lines to " o ", so the verbatim string ' +
      'includes a stray "o". That is correct, not a transcription slip. The other ' +
      'two bullets share this stem and are registered as R-5321-4.2.5-b and -c. ' +
      '`prose`: "accepts responsibility for" has MUST force without a keyword — it ' +
      'is the sentence that makes 250-after-DATA mean something, and the ' +
      'foundation of the entire store-and-forward contract. ' +
      'TRAP for anyone tempted to make this testable: the "(if the recipient ' +
      'mailbox exists)" conditional means a 250 followed by silent discard of mail ' +
      'to a nonexistent mailbox is NOT a violation of this bullet — it falls to ' +
      'the third one (R-5321-4.2.5-c), which requires a notification. Since ' +
      'accepting-then-dropping is the single most consequential misbehaviour a ' +
      'receiver can commit, it is worth noting that this register cannot catch it ' +
      'and that no socket-level suite can. Revisit if task #12 ever grows an ' +
      'outbound sink.',
  },
  {
    id: 'R-5321-4.2.5-b',
    section: '4.2.5',
    page: 53,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'if attempts to deliver the message fail due to transient conditions, ' +
      'retrying delivery some reasonable number of times at intervals as ' +
      'specified in Section 4.5.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'Retry behaviour happens entirely inside the server\'s queue over hours ' +
        'or days, long after our connection closed. Nothing on the wire during a ' +
        'session reveals it.',
    },
    note:
      'Second bullet of the R-5321-4.2.5-a stem; carries the same "accepts ' +
      'responsibility for" force, hence `prose` and MUST. ' +
      'Note "some reasonable number" and "as specified in Section 4.5.4" — §4.5.4 ' +
      'gives SHOULDs and a 4-5 day guideline, not a rule, so even with total ' +
      'visibility into the queue there is barely a failing case here. Untestable ' +
      'twice over.',
  },
  {
    id: 'R-5321-4.2.5-c',
    section: '4.2.5',
    page: 53,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'if attempts to deliver the message fail due to permanent conditions, or if ' +
      'repeated attempts to deliver the message fail due to transient conditions, ' +
      'returning appropriate notification to the sender of the original message ' +
      '(using the address in the SMTP MAIL command).',
    testability: {
      kind: 'not-testable',
      reason:
        'The notification is a new message sent to the reverse-path, days later, ' +
        'over a connection we are not party to. Observing it needs a receiving ' +
        'sink at a domain we control plus DNS — out of scope for a client-side ' +
        'probe.',
    },
    note:
      'Third bullet of the R-5321-4.2.5-a stem. This is the no-silent-discard ' +
      'rule, and the most important thing in §4.2.5: having said 250, a server ' +
      'either delivers or tells the sender it did not. ' +
      'Marked not-testable, but this is the entry to reach for FIRST if the ' +
      'project ever builds an outbound sink (task #12) — it is the highest-value ' +
      'unobservable requirement in the register. Servers that accept-then-drop are ' +
      'common and the failure is invisible to everyone including the sender, which ' +
      'is precisely why it survives. ' +
      'Note "using the address in the SMTP MAIL command" — the notification goes ' +
      'to the reverse-path, NOT to any From: header. A test would have to control ' +
      'the reverse-path domain, not the message.',
  },
  {
    id: 'R-5321-4.2.5-d',
    section: '4.2.5',
    page: 53,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When an SMTP server returns a temporary error status (4yz) code after the ' +
      'DATA command is completed with <CRLF>.<CRLF>, it MUST NOT make a ' +
      'subsequent attempt to deliver that message.',
    testability: {
      kind: 'not-testable',
      reason:
        'A prohibition on the server\'s internal queue. A server that says 4yz ' +
        'and delivers anyway looks identical from the socket to one that says 4yz ' +
        'and discards — the difference only appears at the recipient.',
    },
    note:
      'Looks testable and is not: the observable event (the 4yz reply) is the ' +
      'permitted part, and the forbidden part (delivering anyway) is invisible. ' +
      'The failure mode this forbids is real and nasty — duplicate delivery, since ' +
      'the client will retry — but catching it needs a mailbox we can read. ' +
      'Would become wire-with-fixture with an outbound sink AND a way to force a ' +
      '4yz at end-of-DATA, which itself needs server-side state (a quota, a ' +
      'greylist). Two fixtures deep; not worth optimism.',
  },
  {
    id: 'R-5321-4.2.5-e',
    section: '4.2.5',
    page: 53,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'The SMTP client retains responsibility for the delivery of that message ' +
      'and may either return it to the user or requeue it for a subsequent ' +
      'attempt (see Section 4.5.4.1).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client, and offers two named options so neither can be ' +
        'failed. Our suite has no user to return to and no queue to requeue into.',
    },
    note:
      'Lowercase "may", hence `prose`, though it is a permission either way and ' +
      'nothing turns on the classification. Registered for completeness: the ' +
      'responsibility-transfer model of §4.2.5 has a client half and dropping it ' +
      'would make the section look server-only, which it is not. ' +
      'The suite does neither thing — it records the 4yz and stops. See ' +
      'R-5321-4.2.1-a: retrying against a stranger\'s server is antisocial.',
  },
  {
    id: 'R-5321-4.2.5-f',
    section: '4.2.5',
    page: 54,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The user who originated the message SHOULD be able to interpret the return ' +
      'of a transient failure status (by mail message or otherwise) as a ' +
      'non-delivery indication, just as a permanent failure would be interpreted.',
    testability: {
      kind: 'not-testable',
      reason:
        'The bound party is a human user and the obligation falls on the mail ' +
        'system\'s user interface. There is no SMTP wire event here at all.',
    },
    note:
      'The oddest requirement in the range: it is grammatically about what a USER ' +
      'should be able to do, which no protocol can guarantee. Read as a ' +
      'requirement on the originating mail system to present a transient failure ' +
      'as a non-delivery report rather than swallowing it. Either way it is a UI ' +
      'rule in a transport RFC, and it binds nothing this suite touches. ' +
      'Kept because deleting it would be exactly the flattery the register exists ' +
      'to prevent — an untestable requirement is still a requirement.',
  },
  {
    id: 'R-5321-4.2.5-g',
    section: '4.2.5',
    page: 54,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When an SMTP server returns a permanent error status (5yz) code after the ' +
      'DATA command is completed with <CRLF>.<CRLF>, it MUST NOT make any ' +
      'subsequent attempt to deliver the message.',
    testability: {
      kind: 'not-testable',
      reason:
        'Same shape as R-5321-4.2.5-d: forbids an internal delivery attempt that ' +
        'the socket cannot see. The 5yz we observe is the permitted half.',
    },
    note:
      'The 5yz twin of R-5321-4.2.5-d, and note it is strictly stronger — "any ' +
      'subsequent attempt" versus "a subsequent attempt". Quoted separately rather ' +
      'than merged because the codes, the wording and the client-side consequences ' +
      'all differ. ' +
      'Testable only with the same two-deep fixture: an outbound sink plus a way ' +
      'to force a 5yz at end-of-DATA (oversized message against an advertised ' +
      'SIZE, or content the server rejects). The 5yz half is at least easier to ' +
      'provoke than the 4yz half.',
  },
  {
    id: 'R-5321-4.2.5-h',
    section: '4.2.5',
    page: 54,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'As with temporary error status codes, the SMTP client retains ' +
      'responsibility for the message, but SHOULD not again attempt delivery to ' +
      'the same server without user review of the message and response and ' +
      'appropriate intervention.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our client, and its condition ("without user review") is a ' +
        'human-in-the-loop state no test can be in. The server cannot observe ' +
        'whether a review happened.',
    },
    note:
      '"SHOULD not" — mixed case, the RFC\'s own, quoted as printed. It is a ' +
      'known 5321 typo for "SHOULD NOT" and it matters more than it looks: §1.3 ' +
      'binds conformance to the CAPITALISED terms, so a pedantic reading makes ' +
      'this non-normative. Registered at level SHOULD NOT because the intent is ' +
      'plain and the surrounding sentence is normative; flagged here so nobody ' +
      '"fixes" the quote and breaks the verbatim test. One for 5321bis. ' +
      'Also note it says "to the same server" — retrying a 5yz at a different MX ' +
      'is not covered.',
  },
] as const satisfies readonly RequirementDef[];
