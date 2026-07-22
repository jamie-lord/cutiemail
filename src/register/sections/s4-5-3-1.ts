/**
 * RFC 5321 §4.5.3.1 — Size Limits and Minimums
 * (incl. §§4.5.3.1.1–4.5.3.1.10)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 *
 * Scope notes for this section:
 *  - The per-object subsections (.1.1–.1.7) are stated as bare declarative
 *    facts ("The maximum total length of X is N octets"). Their normative
 *    force is inherited from the §4.5.3.1 umbrella MUST ("Every implementation
 *    MUST be able to receive objects of at least these sizes"), so each is
 *    registered as `prose` at MUST level with that derivation noted. They set
 *    the *minimum a receiver must accept*, not a ceiling the receiver may
 *    enforce below.
 *  - The purely informational sentences — "This section therefore specifies
 *    lengths in octets ...", "SMTP extensions may be used to increase this
 *    limit", "More information may be conveyed through multiple-line replies",
 *    "This number may be increased by the use of SMTP Service Extensions" —
 *    are descriptive, not conformance statements, and are not registered.
 *  - The middle paragraph of §4.5.3.1.10 ("When a conforming SMTP server
 *    encounters this condition, it has at least 100 successful RCPT commands
 *    ...") is an explanatory derivation of the 100-recipient guarantee already
 *    captured by R-5321-4.5.3.1.8-a, and adds no new obligation; not registered.
 */

import type { RequirementDef } from '../types.ts';

export const S4_5_3_1 = [
  // ---- §4.5.3.1 (umbrella) ------------------------------------------------
  {
    id: 'R-5321-4.5.3.1-a',
    section: '4.5.3.1',
    page: 62,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Every implementation MUST be able to receive objects of at least ' +
      'these sizes.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'For each object class in §§4.5.3.1.1–4.5.3.1.7, a request that is ' +
        'valid apart from being exactly the stated minimum size (a 64-octet ' +
        'local-part at a known-good mailbox, a 1000-octet text line in an ' +
        'accepted message, etc.), so a length-based rejection can be told ' +
        'apart from an unknown-recipient or policy rejection.',
    },
    note:
      'The umbrella obligation. This is the normative anchor for the ' +
      'per-object subsections below, which are stated as bare facts. It is a ' +
      'floor, not a ceiling: a receiver MUST accept up to these sizes, but ' +
      'nothing here forbids accepting larger. Hard to test cleanly because a ' +
      'server that rejects an over-minimum object will usually do so with the ' +
      'same code it uses for a nonexistent recipient — the fixture must ' +
      'isolate the length dimension.',
  },
  {
    id: 'R-5321-4.5.3.1-b',
    section: '4.5.3.1',
    page: 62,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Objects larger than these sizes SHOULD be avoided when possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'A generation-side recommendation ("be avoided") hedged by "when ' +
        'possible". Avoiding emitting large objects is not observable from a ' +
        'client connecting to a server, and the hedge makes non-compliance ' +
        'unfalsifiable in any case.',
    },
  },
  {
    id: 'R-5321-4.5.3.1-c',
    section: '4.5.3.1',
    page: 62,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text: 'Clients MAY attempt to transmit these',
    testability: {
      kind: 'not-testable',
      reason:
        'A client permission to send over-minimum objects. Nothing on the ' +
        'wire corresponds to a server taking or declining it; the paired ' +
        'server behaviour is rejection, registered at R-5321-4.5.3.1-d.',
    },
    note:
      'Quoted as the short clause before the comma; the paired "but MUST be ' +
      'prepared ..." obligation is split out as R-5321-4.5.3.1-d because it ' +
      'carries a different keyword.',
  },
  {
    id: 'R-5321-4.5.3.1-d',
    section: '4.5.3.1',
    page: 62,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'but MUST be prepared for a server to reject them if they cannot be ' +
      'handled by it.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client (its readiness to handle a rejection). Server-side ' +
        'we observe only the rejection reply itself, which is permitted, not ' +
        'required, so there is nothing to assert against the server here.',
    },
  },
  {
    id: 'R-5321-4.5.3.1-e',
    section: '4.5.3.1',
    page: 62,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'prose',
    text:
      'To the maximum extent possible, implementation techniques that impose ' +
      'no limits on the length of these objects should be used.',
    testability: {
      kind: 'not-testable',
      reason:
        'A design recommendation about internal implementation technique. ' +
        'Whether a server imposes an internal length limit is not observable ' +
        'in-band, and "to the maximum extent possible" is unfalsifiable.',
    },
    note:
      'Lowercase "should", not an RFC 2119 keyword, hence `prose`; the force ' +
      'is that of a SHOULD but it governs how the code is written, not any ' +
      'wire behaviour.',
  },

  // ---- §4.5.3.1.1 Local-part ---------------------------------------------
  {
    id: 'R-5321-4.5.3.1.1-a',
    section: '4.5.3.1.1',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The maximum total length of a user name or other local-part is 64 ' +
      'octets.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A known-good mailbox whose local-part is 64 octets long, so ' +
        'acceptance can be observed without an unknown-user rejection ' +
        'confounding it.',
    },
    note:
      'Declarative, but conformance-bearing via the §4.5.3.1 umbrella MUST: a ' +
      'receiver MUST be able to receive a 64-octet local-part. This is the ' +
      'minimum it must accept, not a length it may reject at.',
  },

  // ---- §4.5.3.1.2 Domain --------------------------------------------------
  {
    id: 'R-5321-4.5.3.1.2-a',
    section: '4.5.3.1.2',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The maximum total length of a domain name or number is 255 octets.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An address whose domain part is 255 octets and is otherwise ' +
        'acceptable to the server, so a length rejection is distinguishable ' +
        'from an unresolvable/unrelayed-domain rejection.',
    },
    note:
      'Declarative; normative via the §4.5.3.1 umbrella MUST. Minimum a ' +
      'receiver must accept, not a ceiling.',
  },

  // ---- §4.5.3.1.3 Path ----------------------------------------------------
  {
    id: 'R-5321-4.5.3.1.3-a',
    deliberatelyUncovered: {
      reason:
        'needs an otherwise-acceptable 256-octet path the server accepts to isolate path length from an unresolvable-domain rejection, which is server-side accept state not creatable in-band (the local-part and domain sub-floors are covered fixture-gated).',
      date: '2026-07-22',
    },
    section: '4.5.3.1.3',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The maximum total length of a reverse-path or forward-path is 256 ' +
      'octets (including the punctuation and element separators).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A MAIL FROM / RCPT TO path of 256 octets that is otherwise valid ' +
        'and acceptable to the server.',
    },
    note:
      'Declarative; normative via the §4.5.3.1 umbrella MUST. The ' +
      'parenthetical is part of the quoted text.',
  },

  // ---- §4.5.3.1.4 Command Line -------------------------------------------
  {
    id: 'R-5321-4.5.3.1.4-a',
    section: '4.5.3.1.4',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The maximum total length of a command line including the command word ' +
      'and the <CRLF> is 512 octets.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A syntactically valid command exactly 512 octets long including ' +
        'CRLF (e.g. a MAIL FROM with a padded but acceptable path), so a ' +
        '"line too long" rejection can be distinguished from a syntax error.',
    },
    note:
      'Declarative; normative via the §4.5.3.1 umbrella MUST. A receiver MUST ' +
      'accept command lines up to 512 octets; §4.5.3.1.9 shows 500 "Line too ' +
      'long" as the reply for exceeding it. The immediately following ' +
      'informational sentence ("SMTP extensions may be used to increase this ' +
      'limit") is not a conformance statement and is not registered.',
  },

  // ---- §4.5.3.1.5 Reply Line ---------------------------------------------
  {
    id: 'R-5321-4.5.3.1.5-a',
    section: '4.5.3.1.5',
    page: 63,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The maximum total length of a reply line including the reply code and ' +
      'the <CRLF> is 512 octets.',
    testability: { kind: 'wire' },
    note:
      'Declarative; normative via the §4.5.3.1 umbrella MUST. Unusual among ' +
      'these subsections in that the object is *generated by the server*: the ' +
      'client-side receive obligation is untestable by us, but the ' +
      'server-side generation constraint is passively assertable — every ' +
      'reply line observed across the whole suite should be <= 512 octets. ' +
      'That check is cheap but weak: normal replies are short, so we cannot ' +
      'reliably force a server to attempt an over-length reply, and absence ' +
      'of a violation is not proof of compliance.',
  },

  // ---- §4.5.3.1.6 Text Line ----------------------------------------------
  {
    id: 'R-5321-4.5.3.1.6-a',
    section: '4.5.3.1.6',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The maximum total length of a text line including the <CRLF> is 1000 ' +
      'octets (not counting the leading dot duplicated for transparency).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A message to a known-good recipient containing a DATA text line of ' +
        '1000 octets (CRLF included), so acceptance of the line length can be ' +
        'observed at end-of-DATA.',
    },
    note:
      'Declarative; normative via the §4.5.3.1 umbrella MUST — a receiver ' +
      'MUST accept 1000-octet text lines. The dot-stuffing carve-out is part ' +
      'of the quote. The trailing informational sentence ("This number may be ' +
      'increased ...") is not registered.',
  },

  // ---- §4.5.3.1.7 Message Content ----------------------------------------
  {
    id: 'R-5321-4.5.3.1.7-a',
    deliberatelyUncovered: {
      reason:
        'needs a roughly 64K-octet message to a known-good recipient, told apart from a SIZE or policy rejection, which is server-side accept state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.5.3.1.7',
    page: 63,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The maximum total length of a message content (including any message ' +
      'header section as well as the message body) MUST BE at least 64K ' +
      'octets.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A message of ~64K octets to a known-good recipient, distinguishable ' +
        'from a SIZE-limit or policy rejection, to confirm the server accepts ' +
        'at least 64K of content.',
    },
    note:
      '"MUST BE" (two words, capitalised) is the RFC\'s own formatting, ' +
      'quoted as printed. This is the one per-object subsection carrying an ' +
      'explicit keyword rather than relying on the umbrella. A server that ' +
      'advertises SIZE with a value below 65536 is a candidate signal, but ' +
      'the requirement is about actual acceptance, not the advertised value.',
  },
  {
    id: 'R-5321-4.5.3.1.7-b',
    section: '4.5.3.1.7',
    page: 63,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'prose',
    text:
      'message lengths on the Internet have grown dramatically, and message ' +
      'size restrictions should be avoided if at all possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'Lowercase "should", advisory, hedged by "if at all possible". A ' +
        'general recommendation against imposing size restrictions; whether a ' +
        'server has an internal restriction is not observable unless it ' +
        'rejects, and declining to restrict cannot be asserted.',
    },
    note:
      'Registered as `prose` because "should" is lowercase, not an RFC 2119 ' +
      'keyword.',
  },
  {
    id: 'R-5321-4.5.3.1.7-c',
    section: '4.5.3.1.7',
    page: 63,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP server systems that must impose restrictions SHOULD implement the ' +
      '"SIZE" service extension of RFC 1870 [10]',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server that actually imposes a message-size restriction — only ' +
        'then does the SHOULD bite. If so, SIZE should appear in the EHLO ' +
        'response.',
    },
    note:
      'Conditional SHOULD: it only applies to servers that impose size ' +
      'restrictions, which we cannot determine from the wire without first ' +
      'triggering a size rejection. Advertising SIZE is cheaply observable in ' +
      'EHLO, but a server that neither restricts nor advertises is compliant. ' +
      'Non-advertisement is `permitted-latitude`, not failure. RFC 1870 is ' +
      'obsoleted by RFC 6152; 5321 cites the old number and we quote as ' +
      'printed. The reference marker [10] is part of the quote.',
  },
  {
    id: 'R-5321-4.5.3.1.7-d',
    section: '4.5.3.1.7',
    page: 63,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP client systems that will send large messages SHOULD utilize it ' +
      'when possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client (use of the SIZE extension). Nothing about ' +
        'a server\'s behaviour is asserted here.',
    },
  },

  // ---- §4.5.3.1.8 Recipients Buffer --------------------------------------
  {
    id: 'R-5321-4.5.3.1.8-a',
    section: '4.5.3.1.8',
    page: 64,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The minimum total number of recipients that MUST be buffered is 100 ' +
      'recipients.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Up to 100 acceptable RCPT TO addresses (or one address the server ' +
        'will accept repeatedly), so that issuing 100 RCPT commands and ' +
        'observing none rejected for count is possible without unknown-user ' +
        'rejections confounding the result.',
    },
    note:
      'A receiver MUST accept at least 100 recipients in one transaction. ' +
      'Testing needs recipients the server will actually accept — a limit ' +
      'rejection must be told apart from a per-recipient policy/unknown-user ' +
      'rejection. See R-5321-4.5.3.1.8-b, which names sub-100 rejection a ' +
      'violation outright.',
  },
  {
    id: 'R-5321-4.5.3.1.8-b',
    section: '4.5.3.1.8',
    page: 64,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Rejection of messages (for excessive recipients) with fewer than 100 ' +
      'RCPT commands is a violation of this specification.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Fewer than 100 acceptable RCPT commands that the server ' +
        'nonetheless rejects citing recipient count — requires a server ' +
        'configured with a sub-100 recipient cap to exhibit the violation.',
    },
    note:
      'Prose with the force of MUST NOT: names the contrary behaviour "a ' +
      'violation of this specification", the same construction §2.4 uses. ' +
      'This is the falsifiable form of R-5321-4.5.3.1.8-a — a server that ' +
      'refuses recipients before 100 is non-conformant, provided the ' +
      'rejection is genuinely for count and not per-recipient policy.',
  },
  {
    id: 'R-5321-4.5.3.1.8-c',
    section: '4.5.3.1.8',
    page: 64,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'relaying SMTP server MUST NOT, and delivery SMTP servers SHOULD NOT, ' +
      'perform validation tests on message header fields',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether a server performs internal validation tests on header ' +
        'fields is not observable from the wire unless it rejects; and the ' +
        'requirement distinguishes relay from delivery roles, which we cannot ' +
        'establish from a bare connection.',
    },
    note:
      'One clause binding two roles at two levels: relays MUST NOT and ' +
      'delivery servers SHOULD NOT perform header-field validation. Quoted ' +
      'whole and filed at the stronger level (MUST NOT) with the SHOULD NOT ' +
      'for delivery servers noted here, because the shared verb ("perform ' +
      'validation tests ...") cannot be cleanly split between the two ' +
      'subjects. The observable consequence is R-5321-4.5.3.1.8-d.',
  },
  {
    id: 'R-5321-4.5.3.1.8-d',
    section: '4.5.3.1.8',
    page: 64,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'messages SHOULD NOT be rejected based on the total number of ' +
      'recipients shown in header fields.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A message with many recipient addresses in the To:/Cc: header ' +
        'fields but few RCPT commands, delivered to a known-good recipient, ' +
        'to check the server does not reject based on the header count.',
    },
    note:
      'The keyword SHOULD NOT appears literally, but the sentence frames it ' +
      'as what the preceding principle "suggests", softening its force — a ' +
      'derived recommendation rather than a first-class SHOULD NOT. Non- ' +
      'rejection is the compliant case; rejection is `permitted-latitude` ' +
      'under a SHOULD NOT, not an outright failure.',
  },
  {
    id: 'R-5321-4.5.3.1.8-e',
    deliberatelyUncovered: {
      reason:
        'needs a server with a known sub-100 recipient cap to prove over-limit addresses are explicitly rejected rather than silently dropped, which is a configuration not settable in-band.',
      date: '2026-07-22',
    },
    section: '4.5.3.1.8',
    page: 64,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A server that imposes a limit on the number of recipients MUST behave ' +
      'in an orderly fashion, such as rejecting additional addresses over its ' +
      'limit rather than silently discarding addresses previously accepted.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server with a known recipient cap; drive RCPT commands past the ' +
        'cap and check that over-limit addresses are explicitly rejected ' +
        'while already-accepted ones stay accepted, rather than being ' +
        'silently dropped.',
    },
    note:
      'The observable "orderly fashion" is: previously-accepted addresses ' +
      'must not be silently discarded; over-limit ones must be rejected ' +
      'visibly. Silent loss of an earlier-accepted recipient is the ' +
      'violation. Requires provoking the server\'s own limit, hence a ' +
      'fixture.',
  },
  {
    id: 'R-5321-4.5.3.1.8-f',
    section: '4.5.3.1.8',
    page: 64,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'A client that needs to deliver a message containing over 100 RCPT ' +
      'commands SHOULD be prepared to transmit in 100-recipient "chunks" if ' +
      'the server declines to accept more than 100 recipients in a single ' +
      'message.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client\'s retry/chunking strategy. Not observable ' +
        'from a client connecting to a server under test.',
    },
  },

  // ---- §4.5.3.1.9 Treatment When Limits Exceeded -------------------------
  {
    id: 'R-5321-4.5.3.1.9-a',
    section: '4.5.3.1.9',
    page: 64,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Errors due to exceeding these limits may be reported by using the ' +
      'reply codes.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permissive, illustrative statement ("may be reported ... Some ' +
        'examples ..."). The specific codes that follow (500, 501, 452, 552) ' +
        'are labelled examples, not required mappings, so there is no ' +
        'assertion to make about which code a server chooses.',
    },
    note:
      'Lowercase "may", hence `prose`. The four sample codes (500 Line too ' +
      'long / 501 Path too long / 452 Too many recipients / 552 Too much ' +
      'mail data) are explicitly "examples" and impose no obligation; only ' +
      'the "too many recipients" code is pinned down, in §4.5.3.1.10.',
  },

  // ---- §4.5.3.1.10 Too Many Recipients Code ------------------------------
  {
    id: 'R-5321-4.5.3.1.10-a',
    deliberatelyUncovered: {
      reason:
        'needs a server whose recipient buffer is exhausted to observe the 452 too-many-recipients code, which is an implementation-limit state not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.5.3.1.10',
    page: 64,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'The correct reply code for this condition is 452.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server whose RCPT implementation limit is exhausted (its ' +
        'recipients buffer full), to observe that the "too many recipients" ' +
        'condition is reported as 452.',
    },
    note:
      'Prose fixing the correct code (correcting RFC 821\'s erroneous 552). ' +
      'The obligation is restated with an explicit MUST later in the same ' +
      'subsection (R-5321-4.5.3.1.10-c); this sentence is its normative ' +
      'source. "this condition" = an SMTP server exhausting its ' +
      'implementation limit on the number of RCPT commands.',
  },
  {
    id: 'R-5321-4.5.3.1.10-b',
    section: '4.5.3.1.10',
    page: 64,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Clients SHOULD treat a 552 code in this case as a temporary, rather ' +
      'than permanent, failure so the logic below works.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client\'s interpretation of a 552 reply (treating it as ' +
        'transient). Not a server behaviour we can observe.',
    },
  },
  {
    id: 'R-5321-4.5.3.1.10-c',
    deliberatelyUncovered: {
      reason:
        'needs a server with an implementation (not site-policy) RCPT limit to assert the exact 452 code at the cap, which is not creatable in-band.',
      date: '2026-07-22',
    },
    section: '4.5.3.1.10',
    page: 65,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If an SMTP server has an implementation limit on the number of RCPT ' +
      'commands and this limit is exhausted, it MUST use a response code of ' +
      '452',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server with an implementation (not site-policy) limit on RCPT ' +
        'commands; exhaust it and assert the reply code is exactly 452.',
    },
    note:
      'The explicit MUST behind R-5321-4.5.3.1.10-a. Note the distinction the ' +
      'next sentence draws: this 452 requirement is for an *implementation* ' +
      'limit; a *configured site-policy* limit MAY instead use a 5yz ' +
      '(R-5321-4.5.3.1.10-e). A test must know which kind of limit it is ' +
      'hitting, or it may wrongly fail a policy-limited server that returns ' +
      '5yz. Quoted up to the 452; the parenthetical client note is split out ' +
      'as R-5321-4.5.3.1.10-d.',
  },
  {
    id: 'R-5321-4.5.3.1.10-d',
    section: '4.5.3.1.10',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: 'the client SHOULD also be prepared for a 552, as noted above',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client\'s tolerance of a 552 reply in this condition. Not ' +
        'observable from the server side.',
    },
    note:
      'Appears parenthetically inside the sentence quoted for ' +
      'R-5321-4.5.3.1.10-c; split out because it binds the client at SHOULD.',
  },
  {
    id: 'R-5321-4.5.3.1.10-e',
    section: '4.5.3.1.10',
    page: 65,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If the server has a configured site-policy limitation on the number ' +
      'of RCPT commands, it MAY instead use a 5yz response code.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server with a configured site-policy recipient cap (as opposed to ' +
        'an implementation limit); exhaust it and observe whether it returns ' +
        'a 5yz rather than 452.',
    },
    note:
      'The escape hatch that stops R-5321-4.5.3.1.10-c\'s MUST-452 from ' +
      'over-firing: for a *site-policy* cap a permanent 5yz is permitted. ' +
      'Because a bare connection cannot tell an implementation limit from a ' +
      'policy limit, a naive test asserting "recipient exhaustion => 452" can ' +
      'wrongly fail a compliant policy-limited server. Permission, so ' +
      '`permitted-latitude` either way.',
  },
  {
    id: 'R-5321-4.5.3.1.10-f',
    section: '4.5.3.1.10',
    page: 65,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'it would be reasonable to return a 503 response to any DATA command ' +
      'received subsequent to the 452 (or 552) code or to simply return the ' +
      '503 after DATA without returning any previous negative response.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server configured to prohibit messages exceeding a site-specified ' +
        'recipient count; after a 452/552 on RCPT, send DATA and observe ' +
        'whether a 503 is returned.',
    },
    note:
      'Advisory ("it would be reasonable to"), not an RFC 2119 keyword, hence ' +
      '`prose` at MAY force — a permitted, sanctioned behaviour, not a ' +
      'required one. Applies only when the site intends to prohibit ' +
      'over-count messages wholesale. Two permitted shapes: 503 to DATA after ' +
      'the 452/552, or 503 to DATA with no prior negative reply. Unfailable ' +
      'either way.',
  },
] as const satisfies readonly RequirementDef[];
