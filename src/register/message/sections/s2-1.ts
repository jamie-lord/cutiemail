/**
 * RFC 5322 §2.1 — General Description (and §2.1.1 Line Length Limits)
 *
 * Verbatim quotes from spec/rfc5322.txt. Do not paraphrase: the message
 * register's verbatim gate checks every `text` against the vendored RFC.
 *
 * §2.1 sets the bedrock model a parser implements: a message is US-ASCII lines
 * (CRLF-delimited), split into a header section and an optional body by the first
 * empty line, with hard limits on line length. These are the first things any
 * RFC-5322 parser has to get right, and where the security-relevant edge cases
 * (over-long lines, the header/body boundary) live.
 *
 * Party note: RFC 5322 constrains the MESSAGE, which our server both GENERATES
 * (outbound) and PARSES (inbound). We register these as `both` and let the note
 * say which side each check exercises.
 *
 * See docs/decisions/0001-spec-baseline.md, 0007-modern-opinionated-scope.md.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S2_1 = [
  {
    id: 'R-5322-2.1.1-a',
    rfc: 'rfc5322',
    section: '2.1.1',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Each line of characters MUST be no more than 998 characters',
    testability: { kind: 'parse' },
    note:
      'The hard line-length limit, excluding the CRLF. Two duties from one: our ' +
      'generator MUST NOT emit a line over 998 octets (fold long header fields, ' +
      'chunk long body lines per the transfer encoding), and our parser MUST cope ' +
      'with — and flag — an inbound line that exceeds it rather than overflowing a ' +
      'buffer. This is the RFC-5322 analogue of R-5321-4.5.3.1.6-a (SMTP\'s ' +
      '1000-octet text-line limit incl. CRLF); the two agree (998 + CRLF = 1000).',
  },
  {
    id: 'R-5322-2.1.1-b',
    rfc: 'rfc5322',
    section: '2.1.1',
    page: 6,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text: 'SHOULD be no more than 78 characters, excluding the CRLF',
    testability: { kind: 'parse' },
    note:
      'The soft line-length limit. Our generator SHOULD fold to <=78 for display ' +
      'friendliness; declining it is permitted latitude, never a fault. A parser ' +
      'imposes nothing here. Registered so the SHOULD is visibly accounted for.',
  },
  {
    id: 'R-5322-2.1-a',
    rfc: 'rfc5322',
    section: '2.1',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'A message that is conformant with this specification is composed of ' +
      'characters with values in the range of 1 through 127',
    testability: { kind: 'parse' },
    note:
      'PROSE MUST: bare RFC 5322 is 7-bit US-ASCII; a NUL (0) or any 8-bit octet ' +
      'makes a message non-conformant to 5322 ITSELF. But this is the requirement ' +
      'the MIME series (RFC 2045-2049) and internationalised email (RFC 6532, ' +
      'SMTPUTF8) deliberately supersede — the §2.1 Note says so outright. Since ' +
      'this is a MODERN server that speaks 8BITMIME/SMTPUTF8 (see ' +
      '0007-modern-opinionated-scope), the operative rule is the superset: 8-bit ' +
      'is allowed where negotiated, and only a bare NUL is unconditionally ' +
      'rejected. Registered with that supersession recorded, not as a rule we ' +
      'blindly enforce.',
  },
  {
    id: 'R-5322-2.1-b',
    rfc: 'rfc5322',
    section: '2.1',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The body is simply a sequence of characters that follows the header ' +
      'section and is separated from the header section by an empty line',
    testability: { kind: 'parse' },
    note:
      'PROSE MUST — the structural definition a parser implements: split the ' +
      'message at the FIRST empty line (a line with nothing before its CRLF); ' +
      'everything before is the header section, everything after is the body. The ' +
      'security-critical edge: a bare-LF-only blank line, or leading whitespace ' +
      'before the CRLF, must be handled deterministically — header/body confusion ' +
      'is a header-injection and smuggling vector. A message with no empty line is ' +
      'all-headers with an empty body.',
  },
] as const satisfies readonly RequirementDef[];
