/**
 * RFC 5322 §2.2 — Header Fields (structure)
 *
 * The two requirements here are the message-format side of header-injection
 * defence: a field NAME is a tight printable-ASCII set, and a field BODY may not
 * contain a raw CR or LF outside folding. Both are exactly what a header-injection
 * or SMTP-smuggling payload has to violate to sneak an extra header in, so a parser
 * that fails to SEE them is a security hole.
 *
 * Verbatim quotes from spec/rfc5322.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S2_2 = [
  {
    id: 'R-5322-2.2-a',
    rfc: 'rfc5322',
    section: '2.2',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'A field name MUST be composed of printable US-ASCII characters (i.e., ' +
      'characters that have values between 33 and 126, inclusive), except colon',
    testability: { kind: 'parse' },
    note:
      'The header-injection defence. A field name outside 33-126 — a space, a ' +
      'control octet (CR/LF/NUL/TAB), an 8-bit byte — is malformed and is the ' +
      'disguise a smuggled header hides behind. The parser flags it; our generator ' +
      'never emits it. Colon is excluded because it terminates the name.',
  },
  {
    id: 'R-5322-2.2-b',
    rfc: 'rfc5322',
    section: '2.2',
    page: 8,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'A field body MUST NOT include CR and LF except when used in "folding" and ' +
      '"unfolding"',
    testability: { kind: 'parse' },
    note:
      'The other half of header injection: a raw CR or LF inside a field body ends ' +
      'the field early, so anything after it is read as a NEW header — classic ' +
      'header injection (e.g. a user-supplied Subject carrying "\\r\\nBcc: victim"). ' +
      'A conformant parser must SEE the embedded CR/LF (recorded as bare-cr/bare-lf), ' +
      'and our generator must fold legitimately and reject injected control bytes. ' +
      'The permitted exception is genuine folding: a CRLF followed by WSP.',
  },
] as const satisfies readonly RequirementDef[];
