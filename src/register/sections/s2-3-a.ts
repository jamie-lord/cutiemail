/**
 * RFC 5321 §§2.3.1–2.3.7 — SMTP Terminology (first half)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Character of this range: it is a terminology section, and terminology
 * sections are where the RFC hides its definitional MUSTs. Most of what is
 * here defines vocabulary and carries no obligation (§2.3.2 is pure naming;
 * §2.3.6 is an avowed model, "we model this state by a virtual buffer"). But
 * §2.3.5 smuggles in the FQDN rules — four separate prohibitions and the
 * postmaster acceptance MUST, which is one of the few unconditionally
 * testable server obligations this early in the document.
 *
 * §2.3.2 produced no requirements. It is a note that RFC 821's
 * "SMTP-sender"/"SMTP-receiver" are now "client"/"server". Nothing binds.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_3_A = [
  {
    id: 'R-5321-2.3.1-a',
    section: '2.3.1',
    page: 12,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'prose',
    text:
      'those variations have now been deprecated (see Appendix F and ' +
      'Appendix F.6).',
    testability: {
      kind: 'not-testable',
      reason:
        'A deprecation of the MAIL-variant commands (SEND, SOML, SAML), which ' +
        'binds whoever would emit them. Our client will never send them, and ' +
        'this sentence imposes no reply behaviour on a receiver that does.',
    },
    note:
      'DERIVED, hence `prose`: "have now been deprecated" is stated as history, ' +
      'not with a keyword, but deprecating a command is a conformance statement ' +
      'about a feature that RFC 821 permitted. Registered at SHOULD NOT because ' +
      'the RFC never forbids emitting them outright. ' +
      'The normative home is Appendix F.6, not here — whoever extracts that ' +
      'appendix will find the real rule and should link the two. Do not build a ' +
      'test off this entry: a server replying 502 to SEND is conforming, and so ' +
      'is one that still implements it, because nothing in 5321 says which.',
  },
  {
    id: 'R-5321-2.3.1-b',
    section: '2.3.1',
    page: 12,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'The content is textual in nature, expressed using the US-ASCII ' +
      'repertoire [6].',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains what the sender puts in DATA. §2.3.1 states the restriction ' +
        'but gives the receiver no duty to enforce it, so a server that accepts ' +
        '8-bit content is not observably in violation of THIS sentence.',
    },
    note:
      'Stated as fact, hence `prose`. This is the baseline that "8BITMIME" ' +
      'relaxes — the next sentence says extensions "may relax this restriction ' +
      'for the content body". ' +
      'The testable expressions of the ASCII rule live in §2.4: R-5321-2.4-k/-l ' +
      '(envelope commands must stay ASCII, receivers SHOULD reject otherwise) ' +
      'and R-5321-2.4-h (high-order bit in message content). Resist the urge to ' +
      'write a duplicate test here; assert against those IDs instead.',
  },
  {
    id: 'R-5321-2.3.1-c',
    section: '2.3.1',
    page: 12,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'the content header fields are always encoded using the US-ASCII ' +
      'repertoire.',
    testability: {
      kind: 'not-testable',
      reason:
        'Header field octets are only visible to us as bytes we ourselves send ' +
        'inside DATA. No reply code is mandated for a violation, and the ' +
        'delivered message — where the effect would show — is out of reach.',
    },
    note:
      'DERIVED, hence `prose`: "are always encoded" is the same construction as ' +
      '§2.4\'s "is not permitted to", and carries MUST force. Split from ' +
      'R-5321-2.3.1-b deliberately: -b is relaxable by 8BITMIME, this is NOT — ' +
      'the sentence contrasts them explicitly ("Although SMTP extensions ... may ' +
      'relax this restriction for the content body, the content header fields ' +
      'are always ..."). A test author who conflates the two will conclude that ' +
      'negotiating 8BITMIME licenses 8-bit header fields. It does not; RFC 2047 ' +
      'and RFC 2231 exist precisely because it does not.',
  },
  {
    id: 'R-5321-2.3.3-a',
    section: '2.3.3',
    page: 13,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Hence, the reader should be cautious about inferring the strong ' +
      'relationships and responsibilities that might be implied if these terms ' +
      'were used elsewhere.',
    testability: {
      kind: 'not-testable',
      reason:
        'Addressed to the reader of the specification, not to an implementation. ' +
        'There is no wire event corresponding to being cautious about an ' +
        'inference. Registered only so the section is not silently empty.',
    },
    note:
      'MARGINAL — recorded with reservations. The "should" is lowercase, so this ' +
      'is not an RFC 2119 keyword, hence `prose`; and the party is really "the ' +
      'reader", which our `Party` type cannot express, so `both` is the least ' +
      'wrong choice. ' +
      'Kept for the same reason as R-5321-2.4-o: it is exactly the shape of ' +
      'thing an extractor grepping for keywords would either miss or, worse, ' +
      'register as a testable SHOULD. It is a caveat about the MUA/MTA ' +
      'boundary being fuzzy in practice, which §2.3.3 admits ("the implied ' +
      'boundaries between MUAs and MTAs often do not accurately match common, ' +
      'and conforming, practices"). If the register ever grows a `reader-advice` ' +
      'category, this entry moves there.',
  },
  {
    id: 'R-5321-2.3.4-a',
    section: '2.3.4',
    page: 13,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Hosts are known by names (see the next section); they SHOULD NOT be ' +
      'identified by numerical addresses, i.e., by address literals as described ' +
      'in Section 4.1.2.',
    testability: { kind: 'wire' },
    note:
      'The only slice we can observe is the identity the SERVER volunteers: the ' +
      'domain in its 220 greeting (§4.2 requires it) and in the first line of ' +
      'its EHLO response. If either is an address literal, that is this ' +
      'SHOULD NOT being taken. ' +
      'TRAP, and it is a bad one: §2.3.5\'s first exception (R-5321-2.3.5-e) ' +
      'says a host with no name MUST use an address literal in EHLO, and §4.1.3 ' +
      'blesses the form. So an address literal is not per se a defect — it is a ' +
      'SHOULD NOT whose escape hatch is invisible to us, because we cannot tell ' +
      '"this host has no name" from "this host has a name and ignored the rule". ' +
      'A test here must report `permitted-latitude` and record which posture was ' +
      'taken, never fail. Also note the mirror obligation on our own client: we ' +
      'send a real FQDN in EHLO, not [127.0.0.1], or we are the violator.',
  },
  {
    id: 'R-5321-2.3.5-a',
    section: '2.3.5',
    page: 13,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'These components ("labels" in DNS terminology, RFC 1035 [2]) are ' +
      'restricted for SMTP purposes to consist of a sequence of letters, digits, ' +
      'and hyphens drawn from the ASCII character set [6].',
    testability: {
      kind: 'not-testable',
      reason:
        'States a restriction on how names are formed but assigns no party the ' +
        'duty to enforce it. A server accepting an underscore in a domain is ' +
        'not observably violating this sentence, so there is no assertion to ' +
        'make against a reply code.',
    },
    note:
      '"are restricted" rather than "MUST consist of", hence `prose` — the force ' +
      'is a MUST on whoever constructs the name. ' +
      'Deliberately NOT registered as testable, and this is the judgement call ' +
      'most worth arguing with. The tempting test is `MAIL FROM:<a@ex_ample.com>` ' +
      '-> expect 501. But the receiver-side syntax obligation comes from §4.1.2\'s ' +
      'ABNF (Let-dig / Ldh-str) and §4.1.1.11, not from here; asserting it ' +
      'against this ID would credit §2.3.5 with a rule it does not state. ' +
      'Worth knowing anyway: real deployments (Postfix among them) accept ' +
      'underscore-bearing domains on purpose, because they occur in the wild. ' +
      'Whoever extracts §4.1.2 owns the enforceable version.',
  },
  {
    id: 'R-5321-2.3.5-b',
    section: '2.3.5',
    page: 13,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'A domain name that is not in FQDN form is no more than a local alias. ' +
      'Local aliases MUST NOT appear in any SMTP transaction.',
    testability: {
      kind: 'not-testable',
      reason:
        'Prohibits the alias APPEARING, which binds whichever party emits it — ' +
        'in practice our own client. Nothing here obliges a receiver to reject ' +
        'one, so a server that accepts `MAIL FROM:<u@localhost>` is not ' +
        'observably in violation of this sentence.',
    },
    note:
      'The defining sentence is quoted with the prohibition because "Local ' +
      'aliases MUST NOT appear in any SMTP transaction." only means anything ' +
      'given the preceding definition of a local alias as a non-FQDN name. ' +
      '"any SMTP transaction" is broad enough to cover the server\'s own ' +
      'greeting name, which is the one half that is nearly observable — but ' +
      'establishing that the greeting name is not an FQDN needs a DNS lookup, ' +
      'i.e., an out-of-band oracle this suite does not have and which would make ' +
      'the verdict depend on our resolver\'s view rather than on the protocol. ' +
      'Not worth the false-positive risk. See R-5321-2.3.5-c/-d, which say the ' +
      'same thing from the positive and the nickname sides respectively; the RFC ' +
      'states this rule three times in four sentences, and all three are ' +
      'registered separately because they are separately quotable and a future ' +
      'reader will look for each.',
  },
  {
    id: 'R-5321-2.3.5-c',
    section: '2.3.5',
    page: 13,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Only resolvable, fully-qualified domain names (FQDNs) are permitted when ' +
      'domain names are used in SMTP.',
    testability: {
      kind: 'not-testable',
      reason:
        'Resolvability is a DNS fact, not a wire fact. Deciding whether a name ' +
        'the server used is resolvable requires an external resolver, and the ' +
        'answer varies by vantage point — a split-horizon or private-network ' +
        'deployment would be failed for being correctly configured.',
    },
    note:
      '"are permitted" rather than "MUST be", hence `prose`; the force is a MUST. ' +
      'Note what this adds over R-5321-2.3.5-b: **resolvable**. Fully-qualified ' +
      'is a syntactic property; resolvable is not, and that word is what makes ' +
      'the sentence untestable rather than merely awkward. The RFC itself ' +
      'concedes the private-network case in §2.3.4 ("or, in some cases, to a ' +
      'private TCP/IP network"), so a suite that resolved names and failed on ' +
      'NXDOMAIN would be wrong on the RFC\'s own terms. ' +
      'The sentence continues with the exception list, hence R-5321-2.3.5-e/-f/-g.',
  },
  {
    id: 'R-5321-2.3.5-d',
    section: '2.3.5',
    page: 13,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Local nicknames or unqualified names MUST NOT be used.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds whoever uses the name, and assigns the receiver no rejection ' +
        'duty. Same shape as R-5321-2.3.5-b; registered separately because it ' +
        'is a separate sentence with its own keyword.',
    },
    note:
      'The third statement of the FQDN rule in this section (after -b and -c). ' +
      'It is not redundant in one respect: "unqualified names" is the term the ' +
      'postmaster exception (R-5321-2.3.5-g) carves out of, so this is the ' +
      'sentence the exception is an exception TO. ' +
      'Quote is short but unique in the document — "Local nicknames" appears ' +
      'nowhere else.',
  },
  {
    id: 'R-5321-2.3.5-e',
    section: '2.3.5',
    page: 13,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The domain name given in the EHLO command MUST be either a primary host ' +
      'name (a domain name that resolves to an address RR) or, if the host has ' +
      'no name, an address literal, as described in Section 4.1.3 and discussed ' +
      'further in the EHLO discussion of Section 4.1.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client, and this suite is the client. We can comply ' +
        'with it but cannot observe anyone else complying. The receiver-side ' +
        'question — whether a server verifies the EHLO argument — is settled ' +
        'in §4.1.4, which forbids refusing on that basis alone.',
    },
    note:
      'First of the two exceptions to the FQDN rule. Binds us: our client MUST ' +
      'send a resolvable primary host name in EHLO, or an address literal if the ' +
      'test host genuinely has no name. In a container or CI runner that is a ' +
      'real risk — the default hostname is typically not a primary host name, ' +
      'and sending it makes our probes non-conforming in a way some servers will ' +
      'reject us for, producing failures we would misattribute to the server. ' +
      'The EHLO argument should be configurable and should default to an address ' +
      'literal rather than to `hostname`. ' +
      'TRAP if you go looking for a test: §4.1.4 says a server "MUST NOT refuse ' +
      'to accept a message for this reason" even when the EHLO name is bogus, so ' +
      'a server that cheerfully accepts a lie here is conforming, not lax.',
  },
  {
    id: 'R-5321-2.3.5-f',
    section: '2.3.5',
    page: 14,
    level: 'MAY',
    party: 'client',
    normativeSource: 'prose',
    text:
      'The reserved mailbox name "postmaster" may be used in a RCPT command ' +
      'without domain qualification (see Section 4.1.1.3)',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission granted to the sender. Taking it or declining it produces ' +
        'no observable difference in the server. The server-side half is ' +
        'R-5321-2.3.5-g, which is the testable one.',
    },
    note:
      'Lowercase "may", hence `normativeSource: prose` rather than `keyword` — ' +
      'the permission is unambiguous but the RFC did not use the 2119 form here. ' +
      'Split from R-5321-2.3.5-g, which is the same sentence: this clause binds ' +
      'the client, that one binds the server, and only one of them is testable. ' +
      'Quoted up to the parenthetical and no further, so the two entries do not ' +
      'overlap on the "and MUST be accepted" clause.',
  },
  {
    id: 'R-5321-2.3.5-g',
    section: '2.3.5',
    page: 14,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The reserved mailbox name "postmaster" may be used in a RCPT command ' +
      'without domain qualification (see Section 4.1.1.3) and MUST be accepted ' +
      'if so used.',
    testability: { kind: 'wire' },
    note:
      'The prize of this range: an unconditional server MUST needing no fixture. ' +
      '`RCPT TO:<postmaster>` — bare, no domain, angle brackets required — must ' +
      'draw a 250. Every other recipient assertion in the RFC needs us to know a ' +
      'valid mailbox; this one the RFC hands us. ' +
      'Getting the test right, in order of how often it is got wrong: ' +
      '(1) RCPT is only legal after an accepted MAIL, so open with ' +
      '`MAIL FROM:<>` (the null path, which §4.5.1 pairs with postmaster) — a ' +
      '503 out-of-sequence is our bug, not theirs. ' +
      '(2) Assert the BARE form. `postmaster@domain` is a different requirement ' +
      '(§4.5.1) and passing it does not demonstrate this one; a server can ' +
      'accept the qualified form and 501 the unqualified. ' +
      '(3) Do not follow through to DATA. "Accepted" here is about the RCPT ' +
      'reply; whether the message is ultimately delivered is not our business ' +
      'and not observable. ' +
      '(4) Do not treat 4yz as a pass. A temporary failure is not acceptance, ' +
      'though on a greylisting server it is what we will actually get on first ' +
      'contact — expect this to be the most common false failure in the suite ' +
      'and plan a retry, not a looser assertion. ' +
      'Quoted with the leading clause so the entry carries the "without domain ' +
      'qualification" condition that "MUST be accepted if so used" depends on; ' +
      '"if so used" is doing all the scoping work in that clause.',
  },
  {
    id: 'R-5321-2.3.6-a',
    section: '2.3.6',
    page: 14,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'SMTP sessions are stateful, with both parties carefully maintaining a ' +
      'common view of the current state.',
    testability: {
      kind: 'not-testable',
      reason:
        'A premise, not a behaviour: it tells you what kind of protocol SMTP is ' +
        'so that later sections can say "clear the buffer". Every observable ' +
        'consequence is stated as a real requirement in §4.1.1 (command ' +
        'sequencing, RSET, 503 replies) and belongs to those IDs.',
    },
    note:
      'MARGINAL — the only candidate in §2.3.6, and registered mainly so the ' +
      'section is not silently absent from the denominator. ' +
      'The rest of §2.3.6 is explicitly non-normative and should not be mined ' +
      'for requirements: it says "we model this state by a virtual \'buffer\' ' +
      'and a \'state table\' on the server" — a model, with the RFC saying so. ' +
      'The buffer is not a mandated implementation, and a register entry ' +
      'demanding one would be inventing a requirement. This is the section that ' +
      'gives §4.1.1.5 (RSET) its vocabulary; that is where the testing happens.',
  },
  {
    id: 'R-5321-2.3.7-a',
    section: '2.3.7',
    page: 14,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'SMTP commands and, unless altered by a service extension, message data, ' +
      'are transmitted from the sender to the receiver via the transmission ' +
      'channel in "lines".',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender — we are the sender, so we can only comply. The ' +
        'receiver-side counterpart (that a server takes no action on an ' +
        'unterminated line) is R-5321-2.4-f, and the definition of a line is ' +
        'R-5321-2.3.8-a/-b.',
    },
    note:
      'Stated as fact, hence `prose`; "are transmitted ... in lines" has MUST ' +
      'force on whoever transmits. Note the "unless altered by a service ' +
      'extension" hedge covers BDAT (RFC 3030, CHUNKING), where message data is ' +
      'explicitly not line-oriented — commands still are. That carve-out is an ' +
      'extension question, not a 5321 one.',
  },
  {
    id: 'R-5321-2.3.7-b',
    section: '2.3.7',
    page: 14,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'An SMTP reply is an acknowledgment (positive or negative) sent in "lines" ' +
      'from receiver to sender via the transmission channel in response to a ' +
      'command.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: definitional in form, but it establishes two ' +
      'server obligations we can assert cheaply and continuously — every reply ' +
      'is CRLF-terminated, and every command draws exactly one reply. It is a ' +
      'good invariant for the transport layer to enforce on every exchange ' +
      'rather than a standalone test case. ' +
      'TRAP: "in response to a command" does not license asserting one reply per ' +
      'command universally. The 220 greeting responds to no command; ' +
      'multiline replies (§4.2.1) are one reply across several lines and a naive ' +
      'line-counter will read them as several; and pipelining (RFC 2920) means ' +
      'replies arrive batched. Assert reply-per-command at the parsed level, ' +
      'never at the line level. The definitive sequencing rules are §4.1 and ' +
      '§4.2, so if a test fails here, check whether the requirement really lives ' +
      'there before crediting this ID.',
  },
  {
    id: 'R-5321-2.3.7-c',
    section: '2.3.7',
    page: 14,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The general form of a reply is a numeric completion code (indicating ' +
      'failure or success) usually followed by a text string.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`. The testable half is narrow but real: a reply ' +
      'begins with a numeric completion code. Assert that and nothing else. ' +
      'TRAP, and the reason this is registered separately from R-5321-2.3.7-b: ' +
      '"usually followed by a text string" is NOT normative — "usually" and ' +
      '"general form" are both hedges. A bare `250\\r\\n` with no text is ' +
      'conforming, and §4.2 confirms it by making the space-and-text optional in ' +
      'the ABNF. A test that requires text after the code will fail conforming ' +
      'servers, and it is an easy mistake because every server anyone has ever ' +
      'seen does send text. Do not assert on the text at all: the following ' +
      'sentence says "the text is usually intended for human users", which is ' +
      'the RFC telling us it is not ours to parse. ' +
      'The reply-code registry structure (RFC 3463, RFC 5248) referenced at the ' +
      'end of §2.3.7 is enhanced status codes, an extension surface (task #19); ' +
      'nothing in §2.3.7 requires a server to emit them.',
    deliberatelyUncovered: {
      reason:
        'the only convictable content is "a reply begins with a numeric completion code" — and that is structurally guaranteed by the reply reader itself: a response that does not begin with three digits does not FRAME as a reply at all, so there is no wire behaviour a server could exhibit that the reply-code/framing tests (R-5321-4.2-b/-d) do not already catch. The "usually followed by a text string" half is explicitly NON-normative (the note: "usually" and "general form" are hedges; a bare 250 CRLF is conforming), so a text-requiring test would false-positive a conformant server. No dedicated negative control adds signal, so this is deliberately not separately covered.',
      date: '2026-07-16',
    },
  },
] as const satisfies readonly RequirementDef[];
