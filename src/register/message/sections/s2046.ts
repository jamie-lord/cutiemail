/**
 * RFC 2046 §5.1.1 — Common Syntax (the multipart boundary rules)
 *
 * The boundary-confusion surface. A multipart body is split into parts by a
 * delimiter line; every rule here exists so that the sender's intended part
 * structure is the one the receiver reconstructs. The attacks and interop bugs in
 * this area (a boundary hidden in content, a prefix that looks like the boundary,
 * a receiver that treats the preamble as a part) all come from bending one of
 * these rules. So the parser holds them exactly and each defect below is one bend.
 *
 * Verbatim quotes from spec/rfc2046.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S2046 = [
  {
    id: 'R-2046-5.1.1-a',
    rfc: 'rfc2046',
    section: '5.1.1',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The boundary delimiter MUST occur at the beginning of a line, i.e., following a CRLF',
    testability: { kind: 'parse' },
    note:
      'A delimiter is only a delimiter at the start of a line. The same octets ' +
      'appearing mid-line are content, not a split point. Our parser matches ' +
      'only line-start boundaries; the matchBoundaryAnywhere defect (match ' +
      'anywhere) is the negative control — and is precisely how a boundary smuggled ' +
      'into content would hijack the part structure.',
  },
  {
    id: 'R-2046-5.1.1-b',
    rfc: 'rfc2046',
    section: '5.1.1',
    page: 23,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'implementations must ignore anything that appears before the first boundary delimiter line or after the last one.',
    testability: { kind: 'parse' },
    note:
      'The preamble (before the first delimiter) and epilogue (after the closing ' +
      'delimiter) are NOT body parts — they are captured separately and never ' +
      'surfaced as content. The includePreambleAsPart defect (promote the preamble ' +
      'to a part) is the negative control; treating the preamble as a part is a way ' +
      'to make a receiver see content the sender did not structure as a part.',
  },
  {
    id: 'R-2046-5.1.1-c',
    rfc: 'rfc2046',
    section: '5.1.1',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'must be no longer than 70 characters, not counting the two leading hyphens.',
    testability: { kind: 'parse' },
    note:
      'A hard length ceiling on the boundary parameter value (70, excluding the ' +
      'two leading hyphens of the delimiter line). Our parser flags an overlong ' +
      'boundary; the acceptOverlongBoundary defect is the negative control.',
  },
  {
    id: 'R-2046-5.1.1-d',
    rfc: 'rfc2046',
    section: '5.1.1',
    page: 23,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'that the boundary appear in its entirety following the CRLF.',
    testability: { kind: 'parse' },
    note:
      'The full-line comparison rule (the sentence begins "Boundary string ' +
      'comparisons must compare the boundary value ... it is sufficient..."): a ' +
      'line whose start merely resembles the boundary — "--frontierX" against a ' +
      'boundary of "frontier" — is NOT a delimiter. The parser requires the whole ' +
      'boundary token, then only CRLF (a part separator) or "--"+CRLF (the close). ' +
      'The prefixBoundaryMatch defect (accept a boundary that is only a prefix of ' +
      'the line token) is the negative control — the classic boundary-confusion bug.',
  },
] as const satisfies readonly RequirementDef[];
