/**
 * RFC 2045 — MIME Part One: Format of Internet Message Bodies
 *
 * The Content-* header surface: MIME-Version (§4), Content-Type (§5) and its
 * defaults (§5.2), Content-Transfer-Encoding (§6). This is the **MIME-confusion**
 * surface — the class of attacks and interop failures where sender and receiver
 * disagree about a message's type, encoding, or structure. Getting the small,
 * boring rules right (case-insensitive type matching, ignore-unknown-parameters,
 * the text/plain default, unrecognized-encoding → octet-stream) is exactly what
 * stops a crafted Content-Type from being read two different ways by two agents.
 *
 * Opinionated cut (ADR 0007): the parser additionally flags a DUPLICATE
 * Content-Type as ambiguous rather than silently picking one — a classic
 * MIME-confusion vector. That hardening is tested as parser behaviour under
 * R-2045-5-a; the register entries themselves are the RFC's own requirements.
 *
 * Verbatim quotes from spec/rfc2045.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S2045 = [
  {
    id: 'R-2045-4-a',
    rfc: 'rfc2045',
    section: '4',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Messages composed in accordance with this document MUST include such a header field',
    testability: { kind: 'parse' },
    note:
      'The "such a header field" is the verbatim "MIME-Version: 1.0", required at ' +
      'the TOP LEVEL of a message (not per body part). Our analyzer flags a ' +
      'top-level message that lacks it; the dontFlagMissingMimeVersion defect is ' +
      'the negative control. A value other than 1.0 "cannot be assumed to conform", ' +
      'so it is surfaced too.',
  },
  {
    id: 'R-2045-5-a',
    rfc: 'rfc2045',
    section: '5',
    page: 17,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The type, subtype, and parameter names are not case sensitive.',
    testability: { kind: 'parse' },
    note:
      'PROSE that governs matching: "Text/HTML", "text/html" and "TEXT/HTML" are ' +
      'the same media type. Our parser lowercases type/subtype/param-names so ' +
      'downstream comparisons are exact; the caseSensitiveType defect (preserve ' +
      'case) is the negative control. Parameter VALUES stay case-sensitive (§5.1) ' +
      'except where a specific parameter says otherwise. This entry also anchors ' +
      'the opinionated duplicate-Content-Type flag (MIME-confusion hardening).',
  },
  {
    id: 'R-2045-5-b',
    rfc: 'rfc2045',
    section: '5',
    page: 18,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'implementations must ignore any parameters whose names they do not recognize.',
    testability: { kind: 'parse' },
    note:
      'Robustness: an unknown Content-Type parameter must not derail parsing — the ' +
      'type/subtype and the recognized parameters still stand. Our parser records ' +
      'an unknown parameter as ignored and keeps the media type intact; the ' +
      'failOnUnknownParam defect (let an unknown param invalidate the type) is the ' +
      'negative control.',
  },
  {
    id: 'R-2045-5.2-a',
    rfc: 'rfc2045',
    section: '5.2',
    page: 19,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'This default is assumed if no Content-Type header field is specified.',
    testability: { kind: 'parse' },
    note:
      'PROSE stating the default: a message with no Content-Type is text/plain; ' +
      'charset=us-ascii. Our parser materialises that default so every entity has ' +
      'a concrete media type; the noDefaultContentType defect (leave it unset) is ' +
      'the negative control. The RFC also recommends the same default for a ' +
      'syntactically invalid Content-Type — which is the safe reading and what we do.',
  },
  {
    id: 'R-2045-6-a',
    rfc: 'rfc2045',
    section: '6',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Any entity with an unrecognized Content-Transfer-Encoding must be treated ' +
      'as if it has a Content-Type of "application/octet-stream", regardless of ' +
      'what the Content-Type header field actually says.',
    testability: { kind: 'parse' },
    note:
      'The safety rule: if you do not understand the encoding you must NOT try to ' +
      'decode or interpret the body — treat it as opaque octets. Our parser marks ' +
      'an unrecognized CTE and sets the octet-stream treatment flag; the ' +
      'acceptUnknownCte defect (treat an unknown mechanism as decodable) is the ' +
      'negative control. The known mechanisms (7bit/8bit/binary/quoted-printable/' +
      'base64) are themselves case-insensitive (§6.1).',
  },
] as const satisfies readonly RequirementDef[];
