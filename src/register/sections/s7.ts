/**
 * RFC 5321 §7 — Security Considerations (§§7.1–7.9)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Section 7 is mostly discursive security narrative, and much of its normative
 * force is carried by lower-case "should"/"may" and by prose that names a
 * behaviour "a violation" or "not in conformance". Those are registered as
 * `prose` with the level they carry in force, and each note says why. The
 * uppercase RFC 2119 keywords are registered as `keyword`. A large fraction of
 * the section binds operators/sites or is observable only in the delivered
 * message (trace fields), so `not-testable` dominates honestly here.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S7 = [
  // ── §7.1 Mail Security and Spoofing ──────────────────────────────────────
  {
    id: 'R-5321-7.1-a',
    section: '7.1',
    page: 75,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Systems that provide convenient ways for users to alter these header ' +
      'fields on a per-message basis should attempt to establish a primary and ' +
      'permanent mailbox address for the user',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds message-authoring systems (MUAs) that let users rewrite From/' +
        'return-path fields, not an SMTP receiver. Nothing on the wire between a ' +
        'client and a server corresponds to it.',
    },
    note:
      'Lower-case "should" in a parenthetical, hence `prose` not `keyword` — ' +
      'RFC 5321 reserves uppercase for RFC 2119 force, and this is advisory to ' +
      'MUA authors. Registered for completeness; the whole of §7.1 is otherwise ' +
      'narrative with no testable receiver obligation.',
  },

  // ── §7.2 "Blind" Copies ──────────────────────────────────────────────────
  {
    id: 'R-5321-7.2-a',
    section: '7.2',
    page: 76,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Especially when more than one RCPT command is present, and in order to ' +
      'avoid defeating some of the purpose of these mechanisms, SMTP clients and ' +
      'servers SHOULD NOT copy the full set of RCPT command arguments into the ' +
      'header section, either as part of trace header fields or as informational ' +
      'or private-extension header fields.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds "clients and servers". The server half — what it writes into ' +
        'trace/header fields — is visible only in the delivered or relayed ' +
        'message, which a client socket cannot observe; the client half is our ' +
        'own behaviour. Would need a receiving sink (cf. R-5321-2.4-d).',
    },
    note:
      'Quoted "private-extension" as the normaliser rejoins the source line ' +
      'break "private-\\nextension". One entry, party both: same action (copying ' +
      'RCPT args into headers) forbidden to each party, and both halves are ' +
      'unobservable from where this suite sits.',
  },
  {
    id: 'R-5321-7.2-b',
    section: '7.2',
    page: 76,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'sending SMTP systems that are aware of "bcc" use MAY find it helpful to ' +
      'send each blind copy as a separate message transaction containing only a ' +
      'single RCPT command.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission for the sending system to split bcc recipients into ' +
        'separate transactions. It binds and is exercised entirely by the ' +
        'client; the server cannot tell one strategy from the other.',
    },
  },
  {
    id: 'R-5321-7.2-c',
    section: '7.2',
    page: 76,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Receiving systems SHOULD NOT attempt to deduce such relationships and use ' +
      'them to alter the header section of the message for delivery.',
    testability: {
      kind: 'not-testable',
      reason:
        'The prohibited act is altering the delivered message\'s header section ' +
        'based on envelope/header correlation. Observable only in the delivered ' +
        'message, not in the receiver\'s SMTP reply codes.',
    },
  },
  {
    id: 'R-5321-7.2-d',
    section: '7.2',
    page: 76,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'The popular "Apparently-to" header field is a violation of this principle ' +
      'as well as a common source of unintended information disclosure and ' +
      'SHOULD NOT be used.',
    testability: {
      kind: 'not-testable',
      reason:
        'Generating an "Apparently-to" field happens in the delivered message; ' +
        'a client socket never sees the header section the receiver writes. ' +
        'Would need a receiving sink to observe.',
    },
    note:
      'Party both: the field can be inserted by any system handling the message. ' +
      'Concrete instance of the general SHOULD NOT in R-5321-7.2-c, hence quoted ' +
      'as its own entry.',
  },

  // ── §7.3 VRFY, EXPN, and Security ────────────────────────────────────────
  {
    id: 'R-5321-7.3-a',
    section: '7.3',
    page: 76,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'As a corollary to the above, implementations that permit this MUST NOT ' +
      'appear to have verified addresses that are not, in fact, verified.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server configured to disable VRFY/EXPN (the "this" being disabling), ' +
        'plus a known-invalid address, to confirm the reply does not falsely ' +
        'signal verification. Needs server-side policy we cannot set in-band.',
    },
    note:
      'General rule made concrete by R-5321-7.3-b (the 252 requirement) and by ' +
      'the prose in R-5321-7.3-c/d. "appear to have verified" is a reply-code ' +
      'semantics constraint, so the test must reason about which 2yz codes imply ' +
      'a real check.',
  },
  {
    id: 'R-5321-7.3-b',
    section: '7.3',
    page: 76,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If a site disables these commands for security reasons, the SMTP server ' +
      'MUST return a 252 response, rather than a code that could be confused ' +
      'with successful or unsuccessful verification.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server with VRFY (and/or EXPN) deliberately disabled for security. ' +
        'Then VRFY <anything> must draw 252, not 250/550. The disabled state is ' +
        'operator configuration we cannot establish over the wire.',
    },
    note:
      'Note the exact code is pinned (252), unlike most §7 SHOULDs — a server ' +
      'that answers a disabled VRFY with 250 or 550 is non-conformant per ' +
      'R-5321-7.3-c and R-5321-7.3-d respectively. But this only bites when the ' +
      'commands are disabled; a server that genuinely verifies is out of scope ' +
      'of this clause.',
  },
  {
    id: 'R-5321-7.3-c',
    section: '7.3',
    page: 76,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Returning a 250 reply code with the address listed in the VRFY command ' +
      'after having checked it only for syntax violates this rule.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server that has disabled VRFY (per R-5321-7.3-b) yet answers 250 ' +
        'after a syntax-only check. Distinguishing "syntax-only 250" from a ' +
        'genuine 250 needs a known-invalid recipient, i.e. server state.',
    },
    note:
      'DERIVED, hence `prose`: "violates this rule" gives it MUST NOT force ' +
      'without the keyword. It names one specific way to breach R-5321-7.3-a/b.',
  },
  {
    id: 'R-5321-7.3-d',
    section: '7.3',
    page: 76,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'an implementation that "supports" VRFY by always returning 550 whether or ' +
      'not the address is valid is equally not in conformance.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'One address known valid and one known invalid; VRFY on each. A server ' +
        'that returns 550 for both (never discriminating) is the violation. ' +
        'Requires a mailbox we know the server accepts — server-side state.',
    },
    note:
      'DERIVED, hence `prose`: "equally not in conformance" carries MUST NOT ' +
      'force. Trap for a naive test: a server may legitimately defer validity to ' +
      'DATA and thus VRFY-reject uniformly for privacy — you cannot fail it ' +
      'unless you can prove one of the two addresses is actually deliverable.',
  },
  {
    id: 'R-5321-7.3-e',
    section: '7.3',
    page: 77,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Implementations SHOULD still provide support for EXPN',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A known mailing-list address on the server, so EXPN <list> can be seen ' +
        'to expand rather than draw 502/252. Needs a configured list.',
    },
    note:
      'Split from R-5321-7.3-f: same sentence, but this SHOULD binds the ' +
      'implementation while the next binds the site. SHOULD, so a server that ' +
      'disables EXPN is permitted-latitude, not a failure; and disabling is ' +
      'explicitly anticipated by §3.5 and R-5321-7.3-b.',
  },
  {
    id: 'R-5321-7.3-f',
    section: '7.3',
    page: 77,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'but sites SHOULD carefully evaluate the tradeoffs.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds site operators to perform an evaluation — a human/operational ' +
        'act with no wire manifestation. Quoted with leading "but" to sit as a ' +
        'clean substring after the split from R-5321-7.3-e.',
    },
  },
  {
    id: 'R-5321-7.3-g',
    section: '7.3',
    page: 77,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Sites implementing SMTP authentication may choose to make VRFY and EXPN ' +
      'available only to authenticated requestors.',
    testability: {
      kind: 'not-testable',
      reason:
        'A site policy permission (gate VRFY/EXPN behind AUTH). It is optional ' +
        'operator configuration; an unauthenticated probe cannot distinguish ' +
        '"gated by policy" from "disabled" or "unsupported".',
    },
    note:
      'Lower-case "may", hence `prose`. Permission, so unfailable in either ' +
      'direction.',
  },
  {
    id: 'R-5321-7.3-h',
    section: '7.3',
    page: 77,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'VRFY is expected to make a serious attempt to determine validity before ' +
      'generating a response code (see discussion above).',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A valid and an invalid recipient the suite knows about, to check VRFY ' +
        'actually discriminates rather than answering by syntax alone. Needs ' +
        'known server-side recipient state.',
    },
    note:
      'DERIVED, hence `prose`: "is expected to" carries SHOULD force. Restates ' +
      'the §3.5 obligation (the "see discussion above" pointer). Same ' +
      'observation problem as R-5321-7.3-d — you must be able to prove ground ' +
      'truth for at least two addresses.',
  },

  // ── §7.4 Mail Rerouting Based on the 251 and 551 Response Codes ──────────
  {
    id: 'R-5321-7.4-a',
    section: '7.4',
    page: 77,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Before a client uses the 251 or 551 reply codes from a RCPT command to ' +
      'automatically update its future behavior (e.g., updating the user\'s ' +
      'address book), it should be certain of the server\'s authenticity.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client\'s handling of 251/551 (whether it trusts them enough ' +
        'to rewrite an address book). Entirely client-side; nothing a server ' +
        'observes or that this receiver-facing suite can assert.',
    },
    note:
      'Lower-case "should", hence `prose`. The whole of §7.4 is a single ' +
      'client-side caution against a man-in-the-middle reroute.',
  },

  // ── §7.5 Information Disclosure in Announcements ─────────────────────────
  {
    id: 'R-5321-7.5-a',
    section: '7.5',
    page: 77,
    level: 'RECOMMENDED',
    party: 'server',
    normativeSource: 'prose',
    text: 'Sites are encouraged to evaluate the tradeoff with that issue in mind',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds operators to weigh the debugging-vs-disclosure tradeoff — a ' +
        'human judgement, not a wire behaviour. Registered so the denominator ' +
        'reflects the whole section honestly.',
    },
    note:
      '"encouraged" reads as RECOMMENDED in force but is lower-case advisory ' +
      'prose, hence `normativeSource: prose`.',
  },
  {
    id: 'R-5321-7.5-b',
    section: '7.5',
    page: 77,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'implementations SHOULD minimally provide for making type and version ' +
      'information available in some way to other network hosts.',
    testability: { kind: 'wire' },
    note:
      'Cheaply observable: type/version typically appears in the 220 greeting ' +
      'banner or the HELP response. But "in some way" and "minimally" are ' +
      'deliberately loose — a server exposing this via any channel satisfies it, ' +
      'and a bare banner is permitted-latitude, not a failure. Note the tension ' +
      'with common hardening advice to suppress banners; do not fail a server ' +
      'that discloses nothing, since SHOULD tolerates it.',
  },

  // ── §7.6 Information Disclosure in Trace Fields ──────────────────────────
  {
    id: 'R-5321-7.6-a',
    section: '7.6',
    page: 78,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text: 'sites with special concerns about name disclosure should be aware of it.',
    testability: {
      kind: 'not-testable',
      reason:
        'Directs operators to "be aware" of a disclosure risk — an awareness, ' +
        'not a behaviour, and with no wire manifestation at all.',
    },
    note:
      'Lower-case "should" over a non-behaviour ("be aware"), hence `prose`. ' +
      'Kept for completeness; there is nothing here a test could assert.',
  },
  {
    id: 'R-5321-7.6-b',
    section: '7.6',
    page: 78,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'the optional FOR clause should be supplied with caution or not at all ' +
      'when multiple recipients are involved lest it inadvertently disclose the ' +
      'identities of "blind copy" recipients to others.',
    testability: {
      kind: 'not-testable',
      reason:
        'The FOR clause lives in a Received: trace header the receiver writes ' +
        'into the delivered message. A client socket never sees the trace ' +
        'fields, so caution in emitting them cannot be observed here.',
    },
    note:
      'Lower-case "should", hence `prose`. Concerns generation of trace-field ' +
      'content; would need a receiving sink to inspect (cf. R-5321-7.2-a).',
  },

  // ── §7.7 Information Disclosure in Message Forwarding ────────────────────
  {
    id: 'R-5321-7.7-a',
    section: '7.7',
    page: 78,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Sites that are concerned about those issues should ensure that they ' +
      'select and configure servers appropriately.',
    testability: {
      kind: 'not-testable',
      reason:
        'Operator advice to choose/configure servers appropriately regarding ' +
        '251/551 disclosure. Configuration selection is out-of-band; no wire ' +
        'event corresponds to it.',
    },
    note:
      'Lower-case "should", hence `prose`. The underlying disclosure mechanism ' +
      '(251/551 revealing a replacement address) is exercised in §3.4; this ' +
      'clause only advises operators about it.',
  },

  // ── §7.8 Resistance to Attacks ───────────────────────────────────────────
  {
    id: 'R-5321-7.8-a',
    section: '7.8',
    page: 78,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'rational operational behavior requires that servers be permitted to ' +
      'detect such attacks and take action to defend themselves.',
    testability: {
      kind: 'not-testable',
      reason:
        'Grants servers latitude to detect and defend against attacks — a ' +
        'permission, not an obligation, and "detect/defend" is server-internal. ' +
        'There is no behaviour a test could require or forbid.',
    },
    note:
      'DERIVED, `prose`: "requires that servers be permitted" establishes a ' +
      'permission (MAY in force), not a mandate. R-5321-7.8-b gives the ' +
      'illustrative form.',
  },
  {
    id: 'R-5321-7.8-b',
    section: '7.8',
    page: 78,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'it would be reasonable for the server to close the connection after ' +
      'generating an appropriate number of 5yz (normally 550) replies.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A sustained burst of RCPT TO commands to invalid addresses (the ' +
        'described attack shape), to observe whether the server eventually ' +
        'closes the connection after some 5yz replies. Needs known-invalid ' +
        'recipients and tolerance of the server not doing so.',
    },
    note:
      'DERIVED, `prose`, and illustrative ("would be reasonable") — pure ' +
      'permitted-latitude. Connection-close IS observable, but the server may ' +
      'equally keep the connection open forever without violating anything, so ' +
      'this can only ever record which posture was taken, never fail a server. ' +
      '"appropriate number" and "normally 550" are non-normative hedges.',
  },

  // ── §7.9 Scope of Operation of SMTP Servers ──────────────────────────────
  {
    id: 'R-5321-7.9-a',
    section: '7.9',
    page: 78,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'It is a well-established principle that an SMTP server may refuse to ' +
      'accept mail for any operational or technical reason that makes sense to ' +
      'the site providing the server.',
    testability: {
      kind: 'not-testable',
      reason:
        'Broad permission to refuse mail for any site-chosen reason. A refusal ' +
        'is observable, but the permission is unfailable — no legitimate ' +
        'refusal can be marked non-conformant on the strength of this clause.',
    },
    note: 'Lower-case "may", hence `prose`. Foundational latitude for the section.',
  },
  {
    id: 'R-5321-7.9-b',
    section: '7.9',
    page: 78,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'considerable care should be taken and balance maintained if a site ' +
      'decides to be selective about the traffic it will accept and process.',
    testability: {
      kind: 'not-testable',
      reason:
        'Advises operators to exercise care/balance when being selective about ' +
        'accepted traffic. A disposition, not a behaviour; nothing on the wire ' +
        'measures "care" or "balance".',
    },
    note:
      'Lower-case "should", hence `prose`. Counterweight to the R-5321-7.9-a ' +
      'permission — the spec grants the right to reject but urges restraint.',
  },
  {
    id: 'R-5321-7.9-c',
    section: '7.9',
    page: 79,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Some sites have decided to limit the use of the relay function to known ' +
      'or identifiable sources, and implementations SHOULD provide the ' +
      'capability to perform this type of filtering.',
    testability: {
      kind: 'not-testable',
      reason:
        'Requires the implementation to offer a relay-source filtering ' +
        'capability — a feature-existence/configuration property, not an ' +
        'exercised behaviour. Whether the knob exists is invisible from a ' +
        'socket; only its use (an actual rejection) shows, and that is ' +
        'R-5321-7.9-d.',
    },
    note:
      'Quoted with the preceding "Some sites have decided..." clause so the ' +
      '"this type of filtering" referent is unambiguous. The observable ' +
      'consequence — an anti-relay 550 — is R-5321-7.9-d; the general open-relay ' +
      'prohibition lives in §3.6/§4, not here.',
  },
  {
    id: 'R-5321-7.9-d',
    section: '7.9',
    page: 79,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When mail is rejected for these or other policy reasons, a 550 code ' +
      'SHOULD be used in response to EHLO (or HELO), MAIL, or RCPT as ' +
      'appropriate.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A policy-rejection scenario the server actually enforces — e.g. a ' +
        'relay attempt to a domain it will not relay for, or a source it ' +
        'filters — so the reject can be checked for a 550 rather than 5xx/4xx. ' +
        'Needs the server\'s relay/filter policy to be known.',
    },
    note:
      'SHOULD, so a server that policy-rejects with 553/554/551 is ' +
      'permitted-latitude, not a failure — assert the specific 550 only as the ' +
      'preferred code, and never fail a 5yz here. Applies across EHLO/HELO/MAIL/' +
      'RCPT, so the fixture must pin which command carries the rejection.',
  },
] as const satisfies readonly RequirementDef[];
