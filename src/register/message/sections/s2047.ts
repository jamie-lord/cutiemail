/**
 * RFC 2047 — MIME Part Three: Message Header Extensions for Non-ASCII Text
 *
 * The 'encoded-word' surface: how non-ASCII text is smuggled into an otherwise
 * ASCII header ("=?utf-8?B?...?=" / "=?utf-8?Q?...?="). It is a real confusion and
 * injection surface — an encoded-word can hide control characters or an entire
 * second header from a naive reader, so the placement and structure rules exist to
 * bound where the trick is allowed and what a valid one looks like.
 *
 * Verbatim quotes from spec/rfc2047.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S2047 = [
  {
    id: 'R-2047-2-a',
    rfc: 'rfc2047',
    section: '2',
    page: 3,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: "white space characters MUST NOT appear between components of an 'encoded-word'.",
    testability: { kind: 'parse' },
    note:
      'An encoded-word is a single unbroken token: "=?" charset "?" enc "?" text ' +
      '"?=" with no internal whitespace. A "=?utf-8?B?aGk=?=" with a space inside is ' +
      'NOT an encoded-word and must not be decoded as one. Our decoder rejects ' +
      'internal whitespace; the acceptInternalWhitespace defect is the negative ' +
      'control — decoding a broken token is how a hidden payload slips through.',
  },
  {
    id: 'R-2047-2-b',
    rfc: 'rfc2047',
    section: '2',
    page: 3,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: "An 'encoded-word' may not be more than 75 characters long, including",
    testability: { kind: 'parse' },
    note:
      'A hard length ceiling (75, including the charset, encoding, delimiters and ' +
      'encoded text). Longer strings use multiple encoded-words. Our decoder flags ' +
      'an over-75 token; the acceptOverlongWord defect is the negative control. ' +
      'Prose "may not" — normative in force, quoted mid-sentence at the length clause.',
  },
  {
    id: 'R-2047-5-a',
    rfc: 'rfc2047',
    section: '5',
    page: 8,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: "An 'encoded-word' MUST NOT appear in any portion of an 'addr-spec'.",
    testability: { kind: 'parse' },
    note:
      'A placement restriction: an address (local-part or domain) must never be an ' +
      'encoded-word — decoding one there would let a display name masquerade as, or ' +
      'rewrite, the actual address. Our decoder in addr-spec context refuses to ' +
      'decode and flags it; the decodeInAddrSpec defect is the negative control.',
  },
  {
    id: 'R-2047-6.2-a',
    rfc: 'rfc2047',
    section: '6.2',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: "any 'linear-white-space' that separates a pair of adjacent 'encoded-word's is ignored.",
    testability: { kind: 'parse' },
    note:
      'Adjacent encoded-words concatenate: the whitespace between them is dropped, ' +
      'so a long run split across words reassembles without spurious spaces. Our ' +
      'decoder removes inter-word whitespace; the keepInterWordWhitespace defect is ' +
      'the negative control. (Whitespace between an encoded-word and ORDINARY text ' +
      'is preserved — only the encoded-word/encoded-word gap is ignored.)',
  },
  {
    id: 'R-2047-5-b',
    rfc: 'rfc2047',
    section: '5',
    page: 7,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      "an 'encoded-word' that appears in a header field defined as '*text' MUST be " +
      "separated from any adjacent 'encoded-word' or 'text' by 'linear-white-space'.",
    testability: { kind: 'parse' },
    note:
      'The separation rule that bounds where a token is a token: an encoded-word ' +
      "abutting ordinary text with no LWSP (foo=?utf-8?Q?bar?=baz) is NOT an " +
      "'encoded-word' and a conformant reader leaves it literal, so a payload cannot " +
      'glue itself onto surrounding text and be silently decoded. The same LWSP bound ' +
      "governs the phrase (display-name) placement in §5(3). Our decoder only decodes " +
      'a token separated from adjacent text by LWSP (or the field start/end); ' +
      'otherwise it leaves it literal and flags abutting-text. The acceptAbuttingText ' +
      'defect is the negative control. This decoder is a library surface — the live ' +
      'ENVELOPE/BODYSTRUCTURE path preserves raw header bytes and never runs it — but ' +
      'this register asserts the decoder enforces the RFC bound, so the bound holds.',
  },
] as const satisfies readonly RequirementDef[];
