/**
 * RFC 5321 §3.1 — Session Initiation, and §3.2 — Client Initiation
 *
 * Verbatim quotes from spec/rfc5321.txt (lines 959-1002, all under the
 * [Page 18] marker). Do not paraphrase: the register's `every requirement
 * quotes RFC 5321 verbatim` test checks every `text` field against the
 * vendored RFC and will fail on drift.
 *
 * Both sections are overview prose — §3 announces itself as "descriptions of
 * the procedures used in SMTP". The binding syntax and reply codes live in §4.
 * That shapes the extraction: several sentences here restate or foreshadow a
 * §4 requirement rather than create one, and are noted as such so the eventual
 * test is attributed to the section that actually mandates it.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_1 = [
  {
    id: 'R-5321-3.1-a',
    section: '3.1',
    page: 18,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'An SMTP session is initiated when a client opens a connection to a ' +
      'server and the server responds with an opening message.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`, and the weakest prose entry in this file — it is ' +
      'a definition of "session", not a keyword obligation. It is registered ' +
      'because the definition has conformance force in one direction: a server ' +
      'that accepts a TCP connection and never sends an opening message has not ' +
      'initiated a session, and nothing else the client sends can be well-formed. ' +
      'The firm form of this is §4.2 ("the connection is opened with a 220") and ' +
      '§4.3.1\'s command-reply sequence; a test for the greeting SHOULD be ' +
      'attributed there, not here, or the same behaviour gets double-counted in ' +
      'the numerator. ' +
      'Trap for the test author: this sentence says "an opening message", not ' +
      '"220". §3.1 itself goes on to permit 554 (R-5321-3.1-e), and §4.3.2 ' +
      'permits 554 and 421 on connection opening. Asserting 220 here would fail ' +
      'a server that is correctly refusing the session.',
  },
  {
    id: 'R-5321-3.1-b',
    section: '3.1',
    page: 18,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP server implementations MAY include identification of their ' +
      'software and version information in the connection greeting reply ' +
      'after the 220 code, a practice that permits more efficient isolation ' +
      'and repair of any problems.',
    testability: { kind: 'wire' },
    note:
      'A permission, so unfailable in either direction — but which latitude the ' +
      'server takes is cheaply observable in the greeting text and worth ' +
      'recording in the matrix (`permitted-latitude`, per task #9\'s taxonomy). ' +
      'Do not attempt to assert that the banner text IS a software identifier: ' +
      'the RFC gives no syntax for it, and a regex for "Postfix|Exim|Sendmail" ' +
      'would be inventing one. If the greeting is captured at all, the report can ' +
      'quote it and let a human read it. ' +
      'Note the sentence says "after the 220 code" — a server that takes ' +
      'R-5321-3.1-e\'s 554 branch has no obligation and no permission described ' +
      'here at all.',
  },
  {
    id: 'R-5321-3.1-c',
    section: '3.1',
    page: 18,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Implementations MAY make provision for SMTP servers to disable the ' +
      'software and version announcement where it causes security concerns.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the implementation, not the running server: it permits an ' +
        'implementor to ship a configuration knob. Whether such a knob exists ' +
        'is a property of the source tree and the documentation, not of any ' +
        'wire event. A deployment with a bare "220 mail.example.com ESMTP" ' +
        'greeting is indistinguishable from one that never had the option.',
    },
    note:
      'Looks adjacent to the testable R-5321-3.1-b and is not. The distinction ' +
      'is "MAY include X" (a behaviour, observable) versus "MAY make provision ' +
      'for X to be disabled" (a capability of the software, invisible from a ' +
      'socket). Kept in the register because deleting it would quietly shrink ' +
      'the denominator.',
  },
  {
    id: 'R-5321-3.1-d',
    section: '3.1',
    page: 18,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'While some systems also identify their contact point for mail problems, ' +
      'this is not a substitute for maintaining the required "postmaster" ' +
      'address (see Section 4).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A domain the server accepts mail for, so that RCPT TO:<postmaster@domain> ' +
        'can be issued inside a transaction and the reply class observed. ' +
        'Requires server-side state we cannot create in-band — see task #12.',
    },
    note:
      '`prose` on the strength of "the required \'postmaster\' address": the ' +
      'requirement is asserted as already existing, and this sentence closes off ' +
      'one way of pretending to satisfy it. Lowercase "required" is not the RFC ' +
      '2119 keyword, hence `prose` rather than `keyword`. ' +
      'The obligation it points at is §4.5.1 ("any system that includes an SMTP ' +
      'server supporting mail relaying or delivery MUST support the reserved ' +
      'mailbox \'postmaster\'"). A postmaster test belongs there; this entry ' +
      'exists so the cross-reference is not lost, and should be marked covered ' +
      'by the same test rather than given one of its own. ' +
      'The novel half — that a contact point in the banner is NOT a substitute — ' +
      'is not independently testable: there is no way to observe a server ' +
      'believing it has substituted.',
  },
  {
    id: 'R-5321-3.1-e',
    section: '3.1',
    page: 18,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The SMTP protocol allows a server to formally reject a mail session ' +
      'while still allowing the initial connection as follows: a 554 ' +
      'response MAY be given in the initial connection opening message ' +
      'instead of the 220.',
    testability: { kind: 'wire' },
    note:
      'Permission, so unfailable — but it is the gate condition for the three ' +
      'entries that follow (R-5321-3.1-f/g/h), all of which are predicated on ' +
      '"a server taking this approach". Observable: read the greeting and record ' +
      'whether it opened 220 or 554. ' +
      'Quoted with the whole lead-in sentence because "a 554 response MAY be ' +
      'given" alone loses the constraint that the connection is still allowed, ' +
      'which is the entire point of the permission.',
  },
  {
    id: 'R-5321-3.1-f',
    section: '3.1',
    page: 18,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A server taking this approach MUST still wait for the client to send a ' +
      'QUIT (see Section 4.1.1.10) before closing the connection',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server (or a listener/source-IP on it) configured to answer the ' +
        'connection with 554 rather than 220. Without that, the antecedent "a ' +
        'server taking this approach" is never satisfied and the requirement is ' +
        'vacuously true — the test must be skipped, not passed.',
    },
    note:
      'The strongest requirement in §3.1 and the one most likely to be violated: ' +
      'servers that reject on connect very commonly hang up immediately, and ' +
      'blocklist-driven 554s in particular tend to be followed by an instant ' +
      'FIN. Worth testing precisely because it is unfashionable. ' +
      'Two traps. (1) Vacuous pass: if the greeting is 220, this test has ' +
      'observed nothing — record it as not-applicable, never as a pass, or the ' +
      'numerator inflates on every well-behaved server. (2) 421 is not 554: ' +
      '§4.3.2 lets a server give 421 on connection opening and §3.9/§4.1.1.10 ' +
      'let it close after 421. Only the 554 branch is bound by this sentence. ' +
      'Asserting "did not close" needs a timing bound — depends on the ' +
      'expectation model carrying timeouts (task #9). ' +
      'Quoted without the trailing "and SHOULD respond..." clause: that is a ' +
      'separate obligation at a different level, registered as R-5321-3.1-g.',
  },
  {
    id: 'R-5321-3.1-g',
    section: '3.1',
    page: 18,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'and SHOULD respond to any intervening commands with "503 bad sequence ' +
      'of commands".',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Same as R-5321-3.1-f: a connection answered with 554, into which a ' +
        'command (e.g. EHLO) can be sent before QUIT.',
    },
    note:
      'Quoted from the conjunction "and" because the clause has no subject of ' +
      'its own — it hangs off "A server taking this approach" in R-5321-3.1-f — ' +
      'and because the bare "SHOULD respond to any intervening commands..." ' +
      'phrasing is short enough to risk matching elsewhere. Split from -f ' +
      'because the level differs (MUST vs SHOULD) and a server can honour one ' +
      'while failing the other. ' +
      'Assert the code 503, not the text: "bad sequence of commands" is the ' +
      'RFC\'s suggested wording, not a mandated string, and failing a server for ' +
      'its own phrasing would be a false positive. Non-503 is ' +
      '`permitted-latitude` (SHOULD), though a 5yz that is not 503 is worth ' +
      'reporting — 554 repeated at every command is what several real servers do.',
  },
  {
    id: 'R-5321-3.1-h',
    section: '3.1',
    page: 18,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Since an attempt to make an SMTP connection to such a system is ' +
      'probably in error, a server returning a 554 response on connection ' +
      'opening SHOULD provide enough information in the reply text to ' +
      'facilitate debugging of the sending system.',
    testability: {
      kind: 'not-testable',
      reason:
        '"enough information ... to facilitate debugging" is a judgement no ' +
        'assertion can make. Any check we could write — non-empty text, a ' +
        'length floor, presence of a URL — would be a standard we invented, and ' +
        'a server failing it might still be perfectly diagnostic to a human. ' +
        'Compounded by needing the 554-on-connect fixture before the question ' +
        'even arises.',
    },
    note:
      'Registered rather than dropped because it is a real SHOULD binding the ' +
      'party we observe; it just has no machine-checkable predicate. If the ' +
      'report captures the 554 greeting text for R-5321-3.1-e anyway, a human ' +
      'reading that transcript is the only honest evaluator of this one. ' +
      'Do not be tempted to promote it to `wire` on the strength of a ' +
      'reply-text-length heuristic.',
  },

  {
    id: 'R-5321-3.2-a',
    section: '3.2',
    page: 18,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Older SMTP systems that are unable to support service extensions, and ' +
      'contemporary clients that do not require service extensions in the ' +
      'mail session being initiated, MAY use HELO instead of EHLO.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client permission. Nothing on the wire corresponds to a client ' +
        'being entitled to send HELO; only to it doing so. The server-side ' +
        'consequence — that HELO must be accepted — is §4.1.1.1, not this ' +
        'sentence.',
    },
    note:
      'Our client takes this permission deliberately, because R-5321-3.2-b ' +
      'cannot be observed without sending a HELO. ' +
      'Note what the sentence does NOT say: it does not permit a server to ' +
      'refuse HELO on the grounds that the client is not "older" or does not ' +
      '"require service extensions". The qualifiers describe who would want to ' +
      'send HELO, not who is allowed to.',
  },
  {
    id: 'R-5321-3.2-b',
    section: '3.2',
    page: 18,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Servers MUST NOT return the extended EHLO-style response to a HELO ' +
      'command.',
    testability: { kind: 'wire' },
    note:
      'The one clean, bare-connection MUST NOT in this range, and the highest- ' +
      'value entry in the file: connect, send HELO, assert the reply is a single ' +
      'line (i.e. "250 " with a space at the fourth octet, not "250-"). ' +
      'Hyphenated across a line break in the source as "EHLO-" / "style"; quoted ' +
      'as the natural "EHLO-style", which the test normaliser rejoins. ' +
      'Traps. (1) "Extended EHLO-style response" means the multiline ' +
      'extension list, per §4.1.1.1\'s ehlo-ok-rsp. A multiline 250 whose ' +
      'continuation lines are prose greeting rather than extension keywords is ' +
      'arguably not "EHLO-style" — the RFC does not settle this, so a test that ' +
      'fails any multiline HELO reply is over-strict. Prefer to fail only on ' +
      'lines that parse as ehlo-line (a keyword such as PIPELINING, SIZE, ' +
      'STARTTLS). (2) Servers that answer HELO with a 5yz at all (some do, ' +
      'post-submission-port) satisfy this vacuously; that is not a pass for the ' +
      'MUST NOT, it is a different §4.1.1.1 question. (3) Do not conflate with ' +
      'HELO after a prior EHLO in the same session — §4.1.4 resets, and mixing ' +
      'the two muddies which requirement failed.',
  },
  {
    id: 'R-5321-3.2-c',
    section: '3.2',
    page: 18,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'For a particular connection attempt, if the server returns a "command ' +
      'not recognized" response to EHLO, the client SHOULD be able to fall ' +
      'back and send HELO.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and binds it as a capability ("SHOULD be able to") ' +
        'rather than an action — even a client that has the fallback will not ' +
        'exercise it against a server that answers EHLO correctly. Nothing a ' +
        'server does reveals whether the client could have fallen back.',
    },
    note:
      'A requirement on our own tool, not on the system under test: the harness ' +
      'should implement the fallback so that an EHLO-hostile server is still ' +
      'reachable for the rest of the corpus. But the corpus must NOT fall back ' +
      'silently and then report HELO-derived results as EHLO results — record ' +
      'which verb actually succeeded. ' +
      '"For a particular connection attempt" is doing work: it scopes the ' +
      'fallback to this connection and withholds permission to cache "this ' +
      'server is HELO-only" across sessions, which §4.1.4 and operational ' +
      'experience (a server upgraded mid-run) both argue against.',
  },
] as const satisfies readonly RequirementDef[];
