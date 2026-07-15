/**
 * RFC 5321 §4.3 — Sequencing of Commands and Replies
 * (§4.3.1 Sequencing Overview, §4.3.2 Command-Reply Sequences)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * §4.3 itself is a bare header with no prose of its own; all requirements live
 * under §4.3.1 and §4.3.2, and carry those section numbers in their ids.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_3 = [
  // ---- §4.3.1 Sequencing Overview ----
  {
    id: 'R-5321-4.3.1-a',
    section: '4.3.1',
    page: 54,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Unless other arrangements are negotiated through service extensions, ' +
      'the sender MUST wait for this response before sending further commands.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending SMTP client (command pipelining discipline). This ' +
        'suite is the client and observes servers, so it cannot assert its own ' +
        'obligation; the receiving-side counterpart is the PIPELINING extension, ' +
        'not a base-5321 server behaviour we can probe.',
    },
    note:
      'The "unless other arrangements are negotiated" hedge is exactly the ' +
      'PIPELINING extension (RFC 2920), which is an extension question (task ' +
      '#19), not a base-5321 one.',
  },
  {
    id: 'R-5321-4.3.1-b',
    section: '4.3.1',
    page: 54,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'The sender SHOULD wait for this greeting message before sending any ' +
      'commands.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client — whether the client waited for the 220 ' +
        'greeting before speaking is our own behaviour, not something a server ' +
        'reveals on the wire.',
    },
    note:
      'The server-side counterpart worth testing is that a well-behaved server ' +
      'does send the 220 greeting on connection (the S: 220 sequence under ' +
      'CONNECTION ESTABLISHMENT), but that is the "meanings ... MUST be ' +
      'preserved" anchor (R-5321-4.3.1-e), not this client SHOULD.',
  },
  {
    id: 'R-5321-4.3.1-c',
    section: '4.3.1',
    page: 54,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'These SHOULD be strictly adhered to.',
    testability: { kind: 'wire' },
    note:
      '"These" = the alternative success and failure replies listed for each ' +
      'command in the §4.3.2 table. This is the umbrella SHOULD making that ' +
      'table normative for receivers; it is exercised per-command by driving ' +
      'each command and checking the reply class against the listed S:/E: ' +
      'codes. Short quote, but unique in the document. Because it is a SHOULD, ' +
      'a divergent-but-sensible code is `permitted-latitude`, not a failure — ' +
      'and some listed E: codes need server-side state (a rejected recipient, a ' +
      'full mailbox), so per-command coverage is wire-with-fixture case by case.',
  },
  {
    id: 'R-5321-4.3.1-d',
    section: '4.3.1',
    page: 54,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'A receiver MAY substitute text in the replies,',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission with no failing counterpart, and unobservable in any ' +
        'case: reply text is free-form, so there is no canonical baseline ' +
        'against which "substituted" text could be distinguished from a ' +
        "server's native wording.",
    },
    note:
      'Quoted with its trailing comma; the clause continues into the MUST of ' +
      'R-5321-4.3.1-e, which binds the same party but is testable, so they are ' +
      'split. The practical import is only that the human-readable text after ' +
      'the reply code carries no normative weight — the code does.',
  },
  {
    id: 'R-5321-4.3.1-e',
    section: '4.3.1',
    page: 55,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'but the meanings and actions implied by the code numbers and by the ' +
      'specific command reply sequence MUST be preserved.',
    testability: { kind: 'wire' },
    note:
      'The anchor that makes the entire §4.3.2 command-reply table normative: ' +
      'whatever text a server substitutes (R-5321-4.3.1-d), the code number and ' +
      'its position in the command sequence must mean what the table says. ' +
      'Text spans the page 54/55 boundary; the MUST clause itself falls on page ' +
      '55. Tested per specific command sequence (e.g. QUIT -> 221, DATA -> 354 ' +
      'then 250); the state-dependent sequences require fixtures. Assert the ' +
      'code semantics, not the wording.',
  },

  // ---- §4.3.2 Command-Reply Sequences ----
  {
    id: 'R-5321-4.3.2-a',
    section: '4.3.2',
    page: 55,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP clients SHOULD, when possible, interpret only the first digit of ' +
      'the reply',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client (how it parses replies). This suite is the ' +
        'client; how it interprets a reply is its own internal behaviour, not ' +
        'anything a server can observe or that we assert against a server.',
    },
    note:
      'Split from the MUST that follows in the same sentence (R-5321-4.3.2-b): ' +
      'SHOULD interpret-first-digit and MUST be-prepared bind the same party ' +
      'but are distinct obligations.',
  },
  {
    id: 'R-5321-4.3.2-b',
    section: '4.3.2',
    page: 55,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'MUST be prepared to deal with unrecognized reply codes by interpreting ' +
      'the first digit only.',
    testability: {
      kind: 'not-testable',
      reason:
        "Binds the client's reply-parsing robustness. Our own tolerance of " +
        'unfamiliar codes is not observable from, nor asserted against, a ' +
        'server socket.',
    },
    note:
      'Our client SHOULD honour this itself: when a test drives a server that ' +
      'returns an unusual-but-conformant code, the harness must class it by ' +
      'first digit, not fail on the exact number — see the "assert the class, ' +
      'not the code" discipline throughout the register.',
  },
  {
    id: 'R-5321-4.3.2-c',
    section: '4.3.2',
    page: 55,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Unless extended using the mechanisms described in Section 2.2, SMTP ' +
      'servers MUST NOT transmit reply codes to an SMTP client that are other ' +
      'than three digits or that do not start in a digit between 2 and 5 ' +
      'inclusive.',
    testability: { kind: 'wire' },
    note:
      'Strongly testable and high value: every reply the server sends can be ' +
      'checked to be exactly three digits with a leading digit in 2..5. ' +
      'Watch the traps: (1) multiline replies repeat the code on each line, so ' +
      'validate every line; (2) 354 (DATA) leads with 3, which IS in range, so ' +
      'do not flag it; (3) the "Unless extended ... Section 2.2" caveat means ' +
      'an extension could in principle widen this, but base 5321 servers may ' +
      'not, so a bare connection is the right test surface.',
  },
  {
    id: 'R-5321-4.3.2-d',
    section: '4.3.2',
    page: 55,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'the system described in RFC 3463 [25] SHOULD be used in preference to ' +
      'the invention of new codes.',
    testability: {
      kind: 'not-testable',
      reason:
        'Design-time guidance to whoever extends the code set (enhanced status ' +
        'codes, RFC 3463) rather than a per-message behaviour. There is no wire ' +
        'event corresponding to "preferring" one code-design over another.',
    },
    note:
      'Quoted with the "[25]" reference marker as printed. Binds extension ' +
      'designers on both sides; the enhanced-status-code machinery is the ' +
      'ENHANCEDSTATUSCODES extension (RFC 3463), an extension question (task ' +
      '#19).',
  },
  {
    id: 'R-5321-4.3.2-e',
    section: '4.3.2',
    page: 55,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Note that producing a "command not recognized" error in response to the ' +
      'required subset of these commands is a violation of this specification.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "is a violation of this specification" has the ' +
      'force of MUST NOT without the keyword. The "required subset" is the ' +
      'mandatory command set of §4.5.1 (EHLO/HELO, MAIL, RCPT, DATA, RSET, ' +
      'NOOP, QUIT, VRFY). Test by issuing each and asserting the reply is not a ' +
      '500 "command not recognized". Trap: a 502 "command not implemented" (as ' +
      'VRFY legitimately returns) is a DIFFERENT reply and NOT a violation — ' +
      'this rule is specifically about 500-class "not recognized", not 502.',
  },
  {
    id: 'R-5321-4.3.2-f',
    section: '4.3.2',
    page: 55,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Similarly, producing a "command too long" message for a command line ' +
      'shorter than 512 characters would violate the provisions of Section ' +
      '4.5.3.1.4.',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: "would violate the provisions of Section ' +
      '4.5.3.1.4" carries MUST-NOT force. Testable by sending a command line ' +
      'under the limit and asserting no 500 "command too long". Trap: the ' +
      '512-octet limit of §4.5.3.1.4 is measured INCLUDING the terminating ' +
      'CRLF, so a test line must be safely under to avoid a false positive; and ' +
      'this bounds only the base command line, not extended verbs whose §4.5.3.1 ' +
      'limits differ.',
  },
  {
    id: 'R-5321-4.3.2-g',
    section: '4.3.2',
    page: 55,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'commands that are specified in this document as not accepting arguments ' +
      '(DATA, RSET, QUIT) SHOULD return a 501 message if arguments are ' +
      'supplied in the absence of EHLO-advertised extensions.',
    testability: { kind: 'wire' },
    note:
      'Testable: send "DATA foo", "RSET foo", "QUIT foo" (no relevant extension ' +
      'advertised) and expect 501. Being a SHOULD, a server that tolerantly ' +
      'ignores the stray argument is `permitted-latitude`, not a failure. The ' +
      '"in the absence of EHLO-advertised extensions" clause matters: if the ' +
      'server advertised an extension that gives these verbs arguments, 501 is ' +
      'no longer expected — so run this against a bare/plain session.',
  },
  {
    id: 'R-5321-4.3.2-h',
    section: '4.3.2',
    page: 56,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      '504 (a conforming implementation could return this code only in fairly ' +
      'obscure cases)',
    testability: {
      kind: 'not-testable',
      reason:
        'A parenthetical annotation on the EHLO/HELO error table, hedged to the ' +
        'point of being unenforceable ("could return this code only in fairly ' +
        'obscure cases"). It names no concrete forbidden case, so no wire test ' +
        'can distinguish a conforming 504 from a violating one.',
    },
    note:
      'Registered for completeness — it is a soft, near-informative conformance ' +
      'remark rather than a firm constraint. Quoted verbatim from inside the ' +
      'command-reply table under EHLO or HELO.',
  },
  {
    id: 'R-5321-4.3.2-i',
    section: '4.3.2',
    page: 56,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      '502 (permitted only with an old-style server that does not support EHLO)',
    testability: {
      kind: 'not-testable',
      reason:
        'Circular and so unobservable: a server that returns 502 to EHLO is by ' +
        'that very act declaring it does not implement EHLO (the "old-style" ' +
        'case the clause permits), so there is no wire behaviour that separates ' +
        'a permitted 502 from a prohibited one.',
    },
    note:
      '"permitted only" is constraint language, hence registered as prose ' +
      'despite being a table parenthetical. Quoted verbatim; the "old-/style" ' +
      'hyphenated line break is rejoined by the test normaliser.',
  },
] as const satisfies readonly RequirementDef[];
