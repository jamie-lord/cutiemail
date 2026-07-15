/**
 * RFC 5321 §2.4 — General Syntax Principles and Transaction Model
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_4 = [
  {
    id: 'R-5321-2.4-a',
    section: '2.4',
    page: 16,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Verbs and argument values (e.g., "TO:" or "to:" in the RCPT command and ' +
      'extension name keywords) are not case sensitive, with the sole exception ' +
      'in this specification of a mailbox local-part',
    testability: { kind: 'wire' },
    note:
      'DERIVED, hence `prose`: stated as fact rather than with a keyword. The ' +
      'obligation is nonetheless firm — a later paragraph says "A few SMTP ' +
      'servers, in violation of this specification (and RFC 821) require that ' +
      'command verbs be encoded by clients in upper case", which names the ' +
      'contrary behaviour a violation outright. ' +
      'Read as: a server MUST accept command verbs in any case. Test by sending ' +
      '"ehlo" / "eHlO" and expecting the same treatment as "EHLO". ' +
      'This entry is why `normativeSource` exists: a reader must be able to see ' +
      'where we quote and where we infer.',
  },
  {
    id: 'R-5321-2.4-b',
    section: '2.4',
    page: 16,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'a command verb, an argument value other than a mailbox local-part, and ' +
      'free form text MAY be encoded in upper case, lower case, or any mixture ' +
      'of upper and lower case with no impact on its meaning.',
    testability: {
      kind: 'not-testable',
      reason:
        'Phrased as a client permission. The server-side obligation it implies ' +
        'is registered as R-5321-2.4-a, which is the testable form.',
    },
  },
  {
    id: 'R-5321-2.4-c',
    section: '2.4',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The local-part of a mailbox MUST BE treated as case sensitive.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Two addresses differing only in local-part case, where exactly one is ' +
        'a valid recipient. Requires server-side state we cannot create in-band ' +
        '— see task #12.',
    },
    note:
      '"MUST BE" (two words, capitalised) is the RFC\'s own formatting, not a ' +
      'transcription slip. Quoted as printed. ' +
      'Testing this is delicate: §2.4 goes on to say that exploiting local-part ' +
      'case sensitivity "impedes interoperability and is discouraged", and many ' +
      'real servers fold case as a deliberate operational choice. A server that ' +
      'accepts both cases is not observably violating this — it may simply have ' +
      'both as valid recipients. The assertion is narrower than it first looks; ' +
      'be careful not to write a test that fails Postfix for being sensible.',
  },
  {
    id: 'R-5321-2.4-d',
    section: '2.4',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Therefore, SMTP implementations MUST take care to preserve the case of ' +
      'mailbox local-parts.',
    testability: {
      kind: 'not-testable',
      reason:
        'Preservation is observable only downstream of delivery — in the ' +
        'stored message or the next hop\'s envelope — not in the receiver\'s ' +
        'reply codes. Would need a receiving sink and an end-to-end path, ' +
        'which is a different tool. Revisit if task #12 grows an outbound sink.',
    },
  },
  {
    id: 'R-5321-2.4-e',
    section: '2.4',
    page: 16,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Implementations MAY wish to employ this encoding to accommodate those ' +
      'servers.',
    testability: {
      kind: 'not-testable',
      reason:
        'Client permission to work around servers that demand uppercase verbs. ' +
        'Nothing on the wire corresponds to taking or declining it.',
    },
    note:
      'Our client should NOT take this permission: uppercase-only would mask ' +
      'the very defect R-5321-2.4-a tests for.',
  },
  {
    id: 'R-5321-2.4-f',
    section: '2.4',
    page: 16,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The argument clause consists of a variable-length character string ending ' +
      'with the end of the line, i.e., with the character sequence <CRLF>. The ' +
      'receiver will take no action until this sequence is received.',
    testability: { kind: 'wire' },
    note:
      'Stated as fact ("will take no action") rather than with a keyword, hence ' +
      '`prose`. Testable and worth testing: send a complete command with no ' +
      'CRLF and assert silence until the terminator arrives. A server that ' +
      'replies early is acting on an unterminated line — same family of defect ' +
      'as R-5321-2.3.8-a, and a plausible smuggling primitive. ' +
      'Needs a timing bound to assert "no action", so it depends on the ' +
      'expectation model carrying timeouts (task #9).',
  },
  {
    id: 'R-5321-2.4-g',
    section: '2.4',
    page: 17,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'An originating SMTP client that has not successfully negotiated an ' +
      'appropriate extension with a particular server (see the next paragraph) ' +
      'MUST NOT transmit messages with information in the high-order bit of ' +
      'octets.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. As with R-5321-2.3.8-c, our corpus deliberately ' +
        'violates it in order to observe the server\'s response (R-5321-2.4-h).',
    },
  },
  {
    id: 'R-5321-2.4-h',
    section: '2.4',
    page: 17,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If such messages are transmitted in violation of this rule, receiving ' +
      'SMTP servers MAY clear the high-order bit or reject the message as ' +
      'invalid.',
    testability: { kind: 'wire' },
    note:
      'A MAY with two named options, so neither can be failed — but the ' +
      'BEHAVIOUR is worth recording in the matrix, because clearing the high ' +
      'bit and rejecting are very different postures and the difference is a ' +
      'real interop hazard. This is a case for the four-state taxonomy ' +
      '(task #9): the outcome is `permitted-latitude`, and the report should ' +
      'still say which latitude was taken. ' +
      'Detecting "cleared" requires seeing the delivered message, so only the ' +
      '"reject" branch is observable from the client side.',
  },
  {
    id: 'R-5321-2.4-i',
    section: '2.4',
    page: 17,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In general, a relay SMTP SHOULD assume that the message content it has ' +
      'received is valid and, assuming that the envelope permits doing so, ' +
      'relay it without inspecting that content.',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether a relay inspected content is not observable from the client ' +
        'side — only the next hop or the server\'s own internals would show it. ' +
        'The "In general" hedge plus SHOULD makes this advisory in any case.',
    },
    note:
      'Text spans the page 16/17 boundary in spec/rfc5321.txt; quoted continuously.',
  },
  {
    id: 'R-5321-2.4-j',
    section: '2.4',
    page: 17,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Delivery SMTP systems MAY reject such messages, or return them as ' +
      'undeliverable, rather than deliver them.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A message whose content is mislabeled such that the data path cannot ' +
        'accept it — the case the preceding sentence describes.',
    },
    note:
      'Permission with two named options, so unfailable either way. Requires the ' +
      'receiver to inspect content, which R-5321-2.4-i says it SHOULD NOT do — ' +
      'the two sit in deliberate tension. Expect `permitted-latitude` ' +
      'universally; a candidate for deliberate non-coverage after one run.',
  },
  {
    id: 'R-5321-2.4-k',
    section: '2.4',
    page: 17,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In the absence of a server-offered extension explicitly permitting it, a ' +
      'sending SMTP system is not permitted to send envelope commands in any ' +
      'character set other than US-ASCII.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sending system. The corresponding server obligation is ' +
        'R-5321-2.4-l, which is the testable half.',
    },
    note:
      '"is not permitted" rather than "MUST NOT", hence `prose` — the force is ' +
      'identical. Relaxed where SMTPUTF8 (RFC 6531) is negotiated, which is the ' +
      '"server-offered extension" the sentence anticipates; that is an ' +
      'extension question (task #19), not a 5321 one.',
  },
  {
    id: 'R-5321-2.4-l',
    section: '2.4',
    page: 17,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Receiving systems SHOULD reject such commands, normally using "500 ' +
      'syntax error - invalid character" replies.',
    testability: { kind: 'wire' },
    note:
      'Testable: send 8-bit octets in a MAIL FROM without negotiating SMTPUTF8 ' +
      'and expect a 5yz. SHOULD, so non-rejection is `permitted-latitude`, not ' +
      'failure. Assert the class (5yz), not the exact 500 — "normally" is not ' +
      'normative, and failing a server for replying 501 or 550 here would be a ' +
      'false positive.',
  },
  {
    id: 'R-5321-2.4-m',
    section: '2.4',
    page: 17,
    level: 'MAY',
    party: 'client',
    normativeSource: 'keyword',
    text:
      '8-bit message content transmission MAY be requested of the server by a ' +
      'client using extended SMTP facilities, notably the "8BITMIME" extension, ' +
      'RFC 1652 [22].',
    testability: {
      kind: 'not-testable',
      reason:
        'Client permission to request an extension. The server side of 8BITMIME ' +
        'is R-5321-2.4-n and the extension corpus, task #19.',
    },
  },
  {
    id: 'R-5321-2.4-n',
    section: '2.4',
    page: 17,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: '8BITMIME SHOULD be supported by SMTP servers.',
    testability: { kind: 'wire' },
    note:
      'Rare thing: a SHOULD that a server either advertises in EHLO or does not, ' +
      'so it is cheaply observable. Not advertising is `permitted-latitude`. ' +
      'Note RFC 1652 is obsoleted by RFC 6152 — 5321 cites the old number and we ' +
      'quote it as printed; the extension corpus (task #19) tests against 6152.',
  },
  {
    id: 'R-5321-2.4-o',
    section: '2.4',
    page: 17,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'However, it MUST NOT be construed as authorization to transmit ' +
      'unrestricted 8-bit material, nor does 8BITMIME authorize transmission of ' +
      'any envelope material in other than ASCII.',
    testability: {
      kind: 'not-testable',
      reason:
        'A constraint on how the 8BITMIME extension is to be READ, not a ' +
        'behaviour either party performs. There is no wire event that ' +
        'corresponds to construing something.',
    },
    note:
      'Kept in the register precisely because it looks testable and is not. ' +
      'Its consequences are testable via R-5321-2.4-l (envelope must stay ASCII).',
  },
  {
    id: 'R-5321-2.4-p',
    section: '2.4',
    page: 17,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      '8BITMIME MUST NOT be requested by senders for material with the high bit ' +
      'on that is not in MIME format with an appropriate content-transfer ' +
      'encoding;',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the sender. Quoted with its trailing semicolon because the ' +
        'clause that follows (R-5321-2.4-q) is a separate requirement binding ' +
        'the other party.',
    },
  },
  {
    id: 'R-5321-2.4-q',
    section: '2.4',
    page: 17,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'encoding; servers MAY reject such messages.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A server advertising 8BITMIME, plus a message with the high bit set ' +
        'that is not validly MIME-encoded.',
    },
    note:
      'Quoted with the preceding word ("encoding;") because "servers MAY reject ' +
      'such messages." alone is too generic to be a safely unique quote. ' +
      'Permission, so unfailable — and it requires the server to parse message ' +
      'content to notice, which most receivers do not do at SMTP time. Expect ' +
      '`permitted-latitude` universally. Low value; a candidate for deliberate ' +
      'non-coverage once we have run it once.',
  },
] as const satisfies readonly RequirementDef[];
