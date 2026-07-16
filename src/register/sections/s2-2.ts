/**
 * RFC 5321 §2.2 — The Extension Model (§2.2.1 Background, §2.2.2 Definition and
 * Registration of Extensions, §2.2.3 Special Issues with Extensions)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * §2.2 itself is a bare header (line 478) with no body text, so every entry
 * below belongs to one of the three numbered subsections.
 *
 * Character of this section: it is mostly *meta*. Much of §2.2.2 binds the
 * people who write and register extension specifications, not the two ends of
 * a TCP connection, and §2.2.3 opens with an instruction about how to read the
 * rest of the document. Those are registered as `not-testable` rather than
 * dropped — see EXTRACTING.md on the denominator.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_2 = [
  {
    id: 'R-5321-2.2.1-a',
    section: '2.2.1',
    page: 9,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Contemporary SMTP implementations MUST support the basic extension mechanisms.',
    testability: {
      kind: 'not-testable',
      reason:
        '"the basic extension mechanisms" is never enumerated as a testable ' +
        'set. The sentence is an umbrella; the following sentence ("For ' +
        'instance, ...") gives the concrete instances, and those are where the ' +
        'assertable content lives — R-5321-2.2.1-b (server EHLO) and ' +
        'R-5321-2.2.1-d (HELO fallback). Asserting this entry directly would ' +
        'mean inventing a definition the RFC declines to give.',
    },
    note:
      'Registered rather than folded into -b because it is a separately quoted ' +
      'MUST binding both parties, and a reader auditing the section by keyword ' +
      'will look for it. Its force is real but it is discharged entirely by -b ' +
      'and -d; a coverage report should not treat it as an independent gap.',
  },
  {
    id: 'R-5321-2.2.1-b',
    section: '2.2.1',
    page: 9,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'servers MUST support the EHLO command even if they do not implement any ' +
      'specific extensions',
    testability: { kind: 'wire' },
    note:
      'Split out of "For instance, servers MUST support the EHLO command even ' +
      'if they do not implement any specific extensions and clients SHOULD ' +
      'preferentially utilize EHLO rather than HELO." — one sentence, two ' +
      'parties, two levels. The client half is R-5321-2.2.1-c. ' +
      'Cheapest real assertion in the section: connect, EHLO, expect 250. ' +
      'TRAP for the test author: "support" means the verb is implemented, not ' +
      'that any extension is advertised — a bare "250 host.example" with no ' +
      'keyword lines fully satisfies this. Do not assert that the EHLO reply is ' +
      'multiline, and do not require any particular keyword. ' +
      'Second trap: a 5yz to EHLO is a failure, but a 4yz is not necessarily — ' +
      'a server may be temporarily refusing service (§3.1 / §4.2) for reasons ' +
      'unrelated to EHLO support. Probe with HELO to disambiguate: HELO 250 + ' +
      'EHLO 5yz is the violation this entry is looking for.',
  },
  {
    id: 'R-5321-2.2.1-c',
    section: '2.2.1',
    page: 9,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'clients SHOULD preferentially utilize EHLO rather than HELO.',
    testability: { kind: 'wire-client' },
    note:
      'RECLASSIFIED to wire-client (ADR 0008): a SHOULD binding the client. From ' +
      'the receiver seat nothing reveals whether the peer preferred EHLO, but the ' +
      'outbound suite drives our own delivery client and asserts it opens with ' +
      'EHLO. The heloOnly client-defect (never attempt EHLO) is the negative ' +
      'control. The receiver probe-client keeps its ability to open with HELO to ' +
      'exercise R-5321-2.2.1-d — a separate client for a separate job.',
  },
  {
    id: 'R-5321-2.2.1-d',
    section: '2.2.1',
    page: 9,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      '(However, for compatibility with older conforming implementations, SMTP ' +
      'clients and servers MUST support the original HELO mechanisms as a ' +
      'fallback.)',
    testability: { kind: 'wire' },
    note:
      'Quoted with its enclosing parentheses because that is how the RFC prints ' +
      'it; the normaliser does not strip them, so omitting them would fail the ' +
      'verbatim test. ' +
      'Party is `both` and the quote cannot be split by party — the sentence ' +
      'says "clients and servers" in one breath. Only the server half is ' +
      'observable, so testability is `wire` on that half alone: open with HELO ' +
      'and expect 250. ' +
      'TRAP: a modern server that requires STARTTLS or otherwise gates the ' +
      'session may answer HELO with 530, which is not a violation of this ' +
      'requirement. Assert HELO is *understood* (not 500/502 "command not ' +
      'implemented"), not that it is accepted unconditionally. 502 to HELO is ' +
      'the clean violation.',
  },
  {
    id: 'R-5321-2.2.1-e',
    section: '2.2.1',
    page: 10,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'added, it must be done in a way that permits older implementations to ' +
      'continue working acceptably.',
    testability: {
      kind: 'not-testable',
      reason:
        'A design constraint on whoever adds support for new services, not a ' +
        'behaviour either end of a connection performs. "working acceptably" ' +
        'has no wire predicate.',
    },
    note:
      'Lower-case "must", hence `prose`. Quoted from mid-sentence: the sentence ' +
      'begins "If support for those services is to be" on page 9 and continues ' +
      'across the page break to "added, it must be done in a way that ..." on ' +
      'page 10. Page recorded as 10 because the quoted text starts there. ' +
      'Included because the extraction contract asks for every conformance-' +
      'defining statement, and this one states the design rule the whole ' +
      'extension model exists to enforce — but it is aspiration, not assertion.',
  },
  {
    id: 'R-5321-2.2.1-f',
    section: '2.2.1',
    page: 10,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Each and every extension, regardless of its benefits, must be carefully ' +
      'scrutinized with respect to its implementation, deployment, and ' +
      'interoperability costs.',
    testability: {
      kind: 'not-testable',
      reason:
        'Addressed to extension designers and the IETF process. There is no ' +
        'implementation whose conformance this could be measured against, and ' +
        '"carefully scrutinized" is not a machine-checkable predicate.',
    },
    note:
      'Borderline: arguably editorial guidance rather than a requirement at ' +
      'all. Registered because it carries a lower-case "must" and the contract ' +
      'says to be conservative about *dropping* things, not about keeping ' +
      'them. Flagged here so a later reviewer can retire it deliberately rather ' +
      'than by silence.',
  },
  {
    id: 'R-5321-2.2.2-a',
    section: '2.2.2',
    page: 10,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Each service extension registered with the IANA must be defined in a ' +
      'formal Standards-Track or IESG-approved Experimental protocol document.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the IANA registration process, not an SMTP implementation. ' +
        'Nothing on a socket reveals whether a registry entry has a ' +
        'Standards-Track document behind it.',
    },
    note:
      'Lower-case "must", hence `prose`; the force is that of a MUST on ' +
      'registrants. Note the asymmetry with R-5321-2.2.2-d, which *is* about ' +
      'wire behaviour and depends on this registry being well-formed.',
  },
  {
    id: 'R-5321-2.2.2-b',
    section: '2.2.2',
    page: 10,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The definition must include:',
    testability: {
      kind: 'not-testable',
      reason:
        'A requirement on the contents of an extension specification document. ' +
        'It constrains prose written by humans, not octets sent by software.',
    },
    note:
      'One entry, not seven. The bullets that follow (textual name, EHLO ' +
      'keyword value, parameter syntax, additional verbs, MAIL/RCPT ' +
      'parameters, description of behavioural effect, and — across the page ' +
      'break onto page 11 — the MAIL/RCPT maximum-length increment) are the ' +
      'content of this single obligation, not independent requirements: none ' +
      'carries its own keyword and none is separately assertable. Splitting ' +
      'would inflate the denominator with seven identical `not-testable` rows. ' +
      'Worth reading anyway: the last bullet is the origin of the ' +
      'command-length limits in §4.5.3.1, which is where the testable ' +
      'consequences of extension registration actually surface.',
  },
  {
    id: 'R-5321-2.2.2-c',
    section: '2.2.2',
    page: 11,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Keywords beginning with "X" MUST NOT be used in a registered service ' +
      'extension.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the registry, not a server. A violation would be an IANA entry ' +
        'whose keyword starts with "X" — visible in the registry, never on the ' +
        'wire. A server advertising an X-keyword is doing exactly what the ' +
        'preceding sentence permits (bilateral local extension), not violating ' +
        'this.',
    },
    note:
      'Kept because it looks like a server rule and is not — the mirror-image ' +
      'trap to R-5321-2.2.2-e, which really is one. A test author skimming for ' +
      'MUST NOT + "X" could easily write an assertion that fails every server ' +
      'offering XCLIENT or XFORWARD, both of which are legitimate here.',
  },
  {
    id: 'R-5321-2.2.2-d',
    section: '2.2.2',
    page: 11,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Conversely, keyword values presented in the EHLO response that do not ' +
      'begin with "X" MUST correspond to a Standard, Standards-Track, or ' +
      'IESG-approved Experimental SMTP service extension registered with IANA.',
    testability: {
      kind: 'wire',
      // Bare connection + EHLO is enough to collect the keywords; the registry
      // to compare them against is test data we vendor, not server-side state,
      // so this is `wire` rather than `wire-with-fixture`.
    },
    note:
      'Mechanically easy, semantically the most dangerous entry in the section. ' +
      'Collect the EHLO keywords, drop the X-prefixed ones, compare the rest ' +
      'against a vendored snapshot of the IANA "SMTP Service Extension" ' +
      'registry. ' +
      'TRAP 1 — false positives are near-guaranteed. Widely deployed servers ' +
      'advertise unregistered non-X keywords as a matter of course; AUTH was ' +
      'advertised for years before it was registered, and CHUNKING/BINARYMIME ' +
      'style keywords from vendor forks appear bare. A test that fails any ' +
      'server with an unrecognised keyword will fail most of the internet. ' +
      'TRAP 2 — the oracle rots. The IANA registry gains entries; a vendored ' +
      'snapshot silently becomes wrong in the failing direction. The snapshot ' +
      'needs a date and the report needs to say which snapshot it judged ' +
      'against, or the result is not reproducible. ' +
      'TRAP 3 — do not treat the EHLO keyword as the whole line. The line is ' +
      '"keyword SP parameters"; only the first token is the keyword value. ' +
      'Recommendation: report unregistered keywords as an observation, not a ' +
      'failure, until the snapshot problem has an owner. See R-5321-2.2.2-e ' +
      'for the same rule stated as an explicit server obligation.',
    deliberatelyUncovered: {
      reason:
        'deciding whether an advertised non-X keyword is "described in a registered extension" requires the full live IANA SMTP extension registry; without it the suite cannot tell a legitimate new extension from a bogus one and would false-positive on servers advertising recently-registered keywords.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-2.2.2-e',
    section: '2.2.2',
    page: 11,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A conforming server MUST NOT offer non-"X"-prefixed keyword values that ' +
      'are not described in a registered extension.',
    testability: { kind: 'wire' },
    note:
      'Registered separately from R-5321-2.2.2-d despite covering the same ' +
      'ground: -d is phrased as a property of the EHLO response, -e as an ' +
      'explicit prohibition on "a conforming server", and the RFC chose to ' +
      'write both. They are not quite identical — -d demands registration with ' +
      'IANA, -e demands only that the keyword be "described in a registered ' +
      'extension", which is a weaker and vaguer condition (a keyword described ' +
      'inside someone else\'s registered extension document arguably passes -e ' +
      'while failing -d). If a test is written for only one of these, write it ' +
      'for -e: it names the party and the verdict. All three traps in -d apply ' +
      'unchanged.',
    deliberatelyUncovered: {
      reason:
        'same as R-5321-2.2.2-d — cannot enumerate the registered-extension set reliably, so the prohibition is not safely testable without false positives.',
      date: '2026-07-16',
    },
  },
  {
    id: 'R-5321-2.2.2-f',
    section: '2.2.2',
    page: 11,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'verbs beginning with "X" are local extensions that may not be registered ' +
      'or standardized.',
    testability: {
      kind: 'not-testable',
      reason:
        'A rule about what the registry may contain, as with R-5321-2.2.2-c. ' +
        'The full sentence opens "Additional verbs and parameter names are ' +
        'bound by the same rules as EHLO keywords" — an extension by ' +
        'reference, with no independent wire consequence.',
    },
    note:
      'Lower-case "may not", hence `prose`; read as MUST NOT because the ' +
      'sentence is stating a prohibition on registration, not granting ' +
      'latitude. This is a genuine ambiguity in the RFC — "may not" could be ' +
      'read as "are permitted not to be", which would make it a MAY. The ' +
      'reading here follows the parallel with R-5321-2.2.2-c ("MUST NOT be ' +
      'used in a registered service extension"), which the sentence explicitly ' +
      'says the same rules apply as. Either reading is untestable, so nothing ' +
      'downstream turns on it.',
  },
  {
    id: 'R-5321-2.2.2-g',
    section: '2.2.2',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Conversely, verbs not beginning with "X" must always be registered.',
    testability: {
      kind: 'not-testable',
      reason:
        'A server\'s verb set is not enumerable from a socket. There is no way ' +
        'to ask "what verbs do you implement?" — HELP is optional (§4.1.1.8), ' +
        'its output is unstructured free text, and a server may implement a ' +
        'verb it never mentions. Absence of evidence for an unregistered verb ' +
        'is not evidence of absence, so no run of this test could ever produce ' +
        'a meaningful pass.',
    },
    note:
      'Lower-case "must", hence `prose`. The seductive near-test: brute-force a ' +
      'list of known-unregistered verbs and see which get 250. That does not ' +
      'test this requirement — it tests our guess list, and a clean result ' +
      'proves nothing about the verbs we did not guess. Do not let it into the ' +
      'suite disguised as coverage.',
  },
  {
    id: 'R-5321-2.2.3-a',
    section: '2.2.3',
    page: 11,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Extensions that change fairly basic properties of SMTP operation are ' +
      'permitted.',
    testability: {
      kind: 'not-testable',
      reason:
        'A blanket permission granted to extension designers. Nothing is done ' +
        'or not done in consequence of it, so there is no observation that ' +
        'could confirm or deny it.',
    },
    note:
      '"are permitted", hence `prose` with MAY force. Registered because it is ' +
      'load-bearing for the *interpretation* of the rest of the suite rather ' +
      'than for any single test: it is the RFC\'s own statement that a server ' +
      'may, under a negotiated extension, legitimately contradict limits and ' +
      'character-set rules stated elsewhere as MUST. Any test that asserts a ' +
      '§4.5.3 minimum or the ASCII envelope rule (R-5321-2.4-k/l) must first ' +
      'establish that the relevant extension was not negotiated, or it is ' +
      'asserting against a requirement this sentence has already disapplied.',
  },
  {
    id: 'R-5321-2.2.3-b',
    section: '2.2.3',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The text in other sections of this document must be understood in that ' +
      'context.',
    testability: {
      kind: 'not-testable',
      reason:
        'An instruction about how to READ the specification, not a behaviour ' +
        'any implementation performs. There is no wire event corresponding to ' +
        'understanding something in a context — exactly the trap EXTRACTING.md ' +
        'names via R-5321-2.4-o ("MUST NOT be construed as authorization").',
    },
    note:
      'The most important untestable requirement in the section, and it binds ' +
      'us more than it binds any server. It is the general form of the caveat ' +
      'spelled out in R-5321-2.2.3-a: every MUST elsewhere in 5321 is ' +
      'implicitly qualified by "unless an extension changed it". A suite that ' +
      'ignores this reports permitted-latitude as failure. The extension corpus ' +
      '(task #19) is where the obligation is discharged, if anywhere.',
  },
  {
    id: 'R-5321-2.2.3-c',
    section: '2.2.3',
    page: 11,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'it MAY choose, based on the specific extension and circumstances, to ' +
      'requeue the message and try later and/or try an alternate MX host.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds an intermediate SMTP system acting as a client toward its next ' +
        'hop. We are the client in every session we open, so the relay\'s ' +
        'onward behaviour is on a connection we are not party to. Would need ' +
        'us to stand up a receiving sink that declines an extension and then ' +
        'observe requeue/alternate-MX behaviour over time — a different tool.',
    },
    note:
      'A MAY with two alternatives joined by "and/or", so unfailable three ways ' +
      'over even if it were observable. Quoted from mid-sentence; the subject ' +
      '"it" is the intermediate SMTP system introduced earlier in the same ' +
      'sentence, which is why party is `client` despite the actor being a ' +
      'server to somebody.',
  },
  {
    id: 'R-5321-2.2.3-d',
    section: '2.2.3',
    page: 11,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'If this strategy is employed, the timeout to fall back to an unextended ' +
      'format (if one is available) SHOULD be less than the normal timeout for ' +
      'bouncing as undeliverable',
    testability: {
      kind: 'not-testable',
      reason:
        'A relationship between two of a relay\'s internal queue timers, ' +
        'conditional on it having taken the R-5321-2.2.3-c option. Both timers ' +
        'are configuration, not protocol; observing them would mean holding a ' +
        'sink open for the RFC\'s own example period of three days and ' +
        'inferring the timer values from when mail did or did not arrive.',
    },
    note:
      'Quote stops before the parenthetical example ("(e.g., if normal timeout ' +
      'is three days, ...)") — illustrative, not normative, and its "might be" ' +
      'is deliberately non-binding. ' +
      'Note the conditional antecedent: "If this strategy is employed" means a ' +
      'relay that never requeues cannot violate this, so even a vacuous pass ' +
      'would carry no information.',
  },
] as const satisfies readonly RequirementDef[];
