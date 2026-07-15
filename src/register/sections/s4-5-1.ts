/**
 * RFC 5321 §4.5.1 — Minimum Implementation, §4.5.2 — Transparency
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_5_1 = [
  {
    id: 'R-5321-4.5.1-a',
    section: '4.5.1',
    page: 61,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In order to make SMTP workable, the following minimum implementation ' +
      'MUST be provided by all receivers.',
    testability: { kind: 'wire' },
    note:
      'The umbrella obligation; the concrete command list it introduces is ' +
      'R-5321-4.5.1-b. "all receivers" binds every server — even a pure relay ' +
      'or a send-only submission host that also listens must implement the ' +
      'minimum set.',
  },
  {
    id: 'R-5321-4.5.1-b',
    section: '4.5.1',
    page: 61,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The following commands MUST be supported to conform to this ' +
      'specification: EHLO HELO MAIL RCPT DATA RSET NOOP QUIT VRFY',
    testability: { kind: 'wire' },
    note:
      'The command list is indented on nine separate lines in the RFC; the ' +
      'test normaliser collapses that whitespace so the quote reads as one ' +
      'run. Testable per verb: issue each and assert it is recognised (not ' +
      '500/502 "command unrecognized/not implemented"). ' +
      'TRAP on VRFY: §3.5.1 explicitly permits a server to not verify and ' +
      'reply 252/502/551 for policy/privacy reasons — so VRFY being in the ' +
      'mandatory list means the verb MUST be *recognised*, NOT that it must ' +
      'perform verification. A 502 "command not implemented" to VRFY is a ' +
      'conformance question (§3.5.1 discourages a flat 502), but 252/252-style ' +
      'non-committal replies are compliant. Do not fail a server for declining ' +
      'to verify. ' +
      'HELO is mandatory alongside EHLO: a server that answers only EHLO and ' +
      '500s HELO violates this.',
  },
  {
    id: 'R-5321-4.5.1-c',
    section: '4.5.1',
    page: 61,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Any system that includes an SMTP server supporting mail relaying or ' +
      'delivery MUST support the reserved mailbox "postmaster" as a case-' +
      'insensitive local name.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'The server must relay or deliver mail (not be a 554-always sink, per ' +
        'R-5321-4.5.1-d), and we must know a domain it serves so that ' +
        'RCPT TO:<postmaster@that-domain> is a case the server should accept. ' +
        'Establishing which domains a server accepts postmaster for is exactly ' +
        'the server-side state task #12 has to make real.',
    },
    note:
      '"case-insensitive" is hyphenated across a line break in the source ' +
      '(case-/insensitive); quoted as the rejoined word. The obligation is ' +
      'both to accept the mailbox AND to fold its case: POSTMASTER, Postmaster ' +
      'and postmaster must all be honoured. The concrete RCPT-level form of ' +
      'this obligation is R-5321-4.5.1-e. Note the carve-out in ' +
      'R-5321-4.5.1-d: a server that answers 554 on connection is exempt.',
  },
  {
    id: 'R-5321-4.5.1-d',
    section: '4.5.1',
    page: 61,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This postmaster address is not strictly necessary if the server always ' +
      'returns 554 on connection opening (as described in Section 3.1).',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: no keyword, but it grants a conditional ' +
      'exemption from the MUST in R-5321-4.5.1-c, so it has the force of a ' +
      'permission. Read as: a server MAY omit postmaster support IFF it always ' +
      'returns 554 at connection open. The precondition is directly ' +
      'observable (connect, read the greeting, look for 554), but the ' +
      'exemption itself is not something a server "does" — it is a scoping rule ' +
      'on R-5321-4.5.1-c. A test for -c must first check this precondition and ' +
      'skip the postmaster assertion if the server is a 554 sink.',
  },
  {
    id: 'R-5321-4.5.1-e',
    section: '4.5.1',
    page: 61,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The requirement to accept mail for postmaster implies that RCPT ' +
      'commands that specify a mailbox for postmaster at any of the domains ' +
      'for which the SMTP server provides mail service, as well as the special ' +
      'case of "RCPT TO:<Postmaster>" (with no domain specification), MUST be ' +
      'supported.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A domain we know the server provides mail service for, so ' +
        'RCPT TO:<postmaster@domain> can be asserted accepted; plus the ' +
        'domainless RCPT TO:<Postmaster> case, which needs no fixture beyond a ' +
        'relaying/delivering (non-554) server.',
    },
    note:
      'The RCPT-level teeth of R-5321-4.5.1-c, split out because it is ' +
      'separately testable and adds the domainless <Postmaster> case. Two ' +
      'distinct obligations bundled: (1) postmaster@<any served domain> MUST ' +
      'be accepted, (2) the bare "RCPT TO:<Postmaster>" with no domain MUST be ' +
      'accepted. The second is the sharper test — many servers reject a ' +
      'domainless RCPT outright. Assert a 2yz to RCPT, not a specific 250. ' +
      'Quoted with the "<Postmaster>" capitalisation as printed.',
  },
  {
    id: 'R-5321-4.5.1-f',
    section: '4.5.1',
    page: 61,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'prose',
    text:
      'SMTP systems are expected to make every reasonable effort to accept ' +
      'mail directed to Postmaster from any other system on the Internet.',
    testability: {
      kind: 'not-testable',
      reason:
        '"every reasonable effort" from "any other system on the Internet" is ' +
        'an operational disposition, not a single wire behaviour — we cannot ' +
        'connect from arbitrary Internet origins, and "reasonable effort" has ' +
        'no crisp pass/fail. The concrete, testable core is R-5321-4.5.1-e.',
    },
    note:
      'DERIVED, hence `prose`: "are expected to" carries SHOULD-force (an ' +
      'obligation with reasonable exceptions) without the keyword. Recorded ' +
      'because it frames -e and -g: -g names the narrow exception, this is the ' +
      'default expectation it excepts from.',
  },
  {
    id: 'R-5321-4.5.1-g',
    section: '4.5.1',
    page: 61,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'In extreme cases -- such as to contain a denial of service attack or ' +
      'other breach of security -- an SMTP server may block mail directed to ' +
      'Postmaster.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission conditioned on "extreme cases" (DoS, security breach) — ' +
        'server-side operational state we cannot induce in-band, and blocking ' +
        'looks identical on the wire to any other rejection. Nothing to fail.',
    },
    note:
      'Lowercase "may", so `prose` not `keyword` — it is still a genuine ' +
      'permission carving an exception out of R-5321-4.5.1-f. Quoted with the ' +
      'RFC\'s literal "--" dashes. Unfailable (permission) and unobservable ' +
      '(needs an active attack to justify it).',
  },
  {
    id: 'R-5321-4.5.1-h',
    section: '4.5.1',
    page: 61,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, such arrangements SHOULD be narrowly tailored so as to avoid ' +
      'blocking messages that are not part of such attacks.',
    testability: {
      kind: 'not-testable',
      reason:
        'Constrains the shape of a blocking policy ("narrowly tailored") that ' +
        'only exists during an attack (R-5321-4.5.1-g). We cannot create the ' +
        'attack conditions, and "narrowly tailored" is a judgement, not a ' +
        'wire-observable predicate.',
    },
  },
  {
    id: 'R-5321-4.5.2-a',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'client',
    normativeSource: 'prose',
    text:
      'Before sending a line of mail text, the SMTP client checks the first ' +
      'character of the line.  If it is a period, one additional period is ' +
      'inserted at the beginning of the line.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending client (dot-stuffing on transmit). This suite ' +
        'connects to a server and never observes a client transmitting, so ' +
        'the stuffing step is out of view. The server-side counterpart is ' +
        'R-5321-4.5.2-b / -c.',
    },
    note:
      'DERIVED, hence `prose`: the transparency procedure is stated as ' +
      'imperative fact ("is inserted"), not with a keyword, but it defines ' +
      'conformant client behaviour — a client that fails to stuff a leading ' +
      'period corrupts the message or truncates it at a bare-period line. Our ' +
      'own client MUST implement this to send test bodies faithfully.',
  },
  {
    id: 'R-5321-4.5.2-b',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'When a line of mail text is received by the SMTP server, it checks the ' +
      'line.  If the line is composed of a single period, it is treated as the ' +
      'end of mail indicator.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server accepts, so a MAIL/RCPT/DATA transaction can ' +
        'be driven to the point of sending "<CRLF>.<CRLF>" and observing the ' +
        'final 250. Reaching DATA needs at least one accepted RCPT — the ' +
        'server-side state task #12 must supply.',
    },
    note:
      'DERIVED, hence `prose`: imperative fact, no keyword, but it defines the ' +
      'fundamental end-of-data behaviour — a bare "." line terminates the ' +
      'message. Split from the dot-unstuffing clause (R-5321-4.5.2-c) because ' +
      'this half is observable on the wire (the transaction completes) while ' +
      'that half is only visible in the delivered message. Assert a 2yz after ' +
      '"<CRLF>.<CRLF>".',
  },
  {
    id: 'R-5321-4.5.2-c',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the first character is a period and there are other characters on ' +
      'the line, the first character is deleted.',
    testability: {
      kind: 'not-testable',
      reason:
        'Server-side dot-unstuffing (stripping the leading period the client ' +
        'stuffed) is observable only in the delivered/stored message, not in ' +
        'any reply code. We have no receiving sink to read the body back out, ' +
        'so the deletion is invisible from the socket. Revisit if task #12 ' +
        'grows an outbound sink.',
    },
    note:
      'DERIVED, hence `prose`: imperative fact defining the receiver\'s ' +
      'unstuffing obligation. Split from R-5321-4.5.2-b: same sentence, ' +
      'different party-visible surface — the end-of-mail check shows on the ' +
      'wire, the leading-period deletion does not. A server that fails to ' +
      'unstuff silently doubles leading periods in delivered mail.',
  },
  {
    id: 'R-5321-4.5.2-d',
    section: '4.5.2',
    page: 62,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'The mail data may contain any of the 128 ASCII characters.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'An accepted recipient so a DATA body can be submitted; then a body ' +
        'containing control characters (tabs, other C0 codes) to confirm the ' +
        'server accepts rather than rejects it. Needs the same valid-mailbox ' +
        'state as R-5321-4.5.2-b.',
    },
    note:
      'Lowercase "may", so `prose` not `keyword`. Read together with ' +
      'R-5321-4.5.2-e ("All characters are to be delivered"): the server MUST ' +
      'NOT reject a message merely because its body contains control ' +
      'characters within the 128-code ASCII set. TRAP: real servers commonly ' +
      'apply content filtering (antivirus, policy) and may reject on body ' +
      'content for reasons outside this clause — a rejection is not by itself ' +
      'a violation, so expect `permitted-latitude`. Only a server that rejects ' +
      'plain ASCII control chars with no other justification is suspect.',
  },
  {
    id: 'R-5321-4.5.2-e',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'All characters are to be delivered to the recipient\'s mailbox, ' +
      'including spaces, vertical and horizontal tabs, and other control ' +
      'characters.',
    testability: {
      kind: 'not-testable',
      reason:
        'Delivery fidelity is observable only in the stored mailbox / next ' +
        'hop, not in the receiver\'s reply codes. We have no sink to read the ' +
        'delivered body, so whether tabs and control characters survived is ' +
        'invisible from the client socket.',
    },
    note:
      'DERIVED, hence `prose`: "are to be delivered" is a MUST-force ' +
      'obligation stated without the keyword. This is the delivery-side ' +
      'counterpart to the acceptance permission R-5321-4.5.2-d.',
  },
  {
    id: 'R-5321-4.5.2-f',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'If the transmission channel provides an 8-bit byte (octet) data ' +
      'stream, the 7-bit ASCII codes are transmitted, right justified, in the ' +
      'octets, with the high-order bits cleared to zero.',
    testability: {
      kind: 'not-testable',
      reason:
        'Describes the octet-level encoding of 7-bit ASCII on an 8-bit ' +
        'channel (high bit zeroed). We cannot observe another party\'s ' +
        'octet-packing from a reply, and on a modern 8-bit clean channel this ' +
        'is invisible framing detail, not a distinct behaviour. The ' +
        'observable high-bit rule for 8-bit content lives at §2.4 ' +
        '(R-5321-2.4-g/-h).',
    },
    note:
      'DERIVED, hence `prose`: stated as fact ("are transmitted") but defines ' +
      'how conforming ASCII data appears on the octet stream. "8-bit" and ' +
      '"high-order" are hyphenated mid-line in the source and quoted as-is. ' +
      'Cross-refers §3.6 for relay-function special cases.',
  },
  {
    id: 'R-5321-4.5.2-g',
    section: '4.5.2',
    page: 62,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If such transformations are necessary, they MUST be reversible, ' +
      'especially if they are applied to mail being relayed.',
    testability: {
      kind: 'not-testable',
      reason:
        'Reversibility of an internal storage/character-set transformation is ' +
        'a property of the server\'s data handling, not a wire event. We ' +
        'cannot see the stored form, and even round-tripping through relay ' +
        'would need a downstream sink to compare against the original.',
    },
    note:
      'The one explicit keyword MUST in §4.5.2. Binds servers that transform ' +
      'data on receipt (different local charset, record storage, delimiter ' +
      'sequences). Untestable from a socket: the loss the rule guards against ' +
      'only manifests in the delivered/relayed message.',
  },
] as const satisfies readonly RequirementDef[];
