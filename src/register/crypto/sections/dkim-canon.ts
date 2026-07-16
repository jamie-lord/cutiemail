/**
 * RFC 6376 §3.4 — DKIM Canonicalization
 *
 * Canonicalization is the subtle, bug-prone heart of DKIM: signer and verifier
 * must transform the same message to the same octets, or every signature fails (or
 * worse, a mismatch is exploitable). Two algorithms each for header and body —
 * "simple" (near-verbatim) and "relaxed" (whitespace-normalising). The relaxed
 * steps are an ordered recipe and getting the order or a single WSP rule wrong
 * silently breaks interop, which is why RFC 6376 §3.4.5 ships worked examples: this
 * register's corpus uses those as GROUND TRUTH, not just our own mutants.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_CANON = [
  {
    id: 'R-6376-3.4.1-a',
    rfc: 'rfc6376',
    section: '3.4.1',
    page: 14,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'header field names MUST NOT be case folded and whitespace MUST NOT be changed.',
    testability: { kind: 'parse' },
    note:
      'Simple header canonicalization does not change header fields in any way. Our ' +
      'simpleHeaderField returns the field exactly as received; the ' +
      'simpleHeaderMutatesWhitespace defect (normalise the whitespace) is the ' +
      'negative control and is verified against the §3.4.5 Example 2 vector.',
  },
  {
    id: 'R-6376-3.4.2-a',
    rfc: 'rfc6376',
    section: '3.4.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Convert all header field names (not the header field values) to lowercase.',
    testability: { kind: 'parse' },
    note:
      'First relaxed-header step (the algorithm "MUST apply the following steps in ' +
      'order"). "SUBJect" -> "subject"; the VALUE keeps its case. The ' +
      'relaxedHeaderKeepsCase defect is the negative control.',
  },
  {
    id: 'R-6376-3.4.2-b',
    rfc: 'rfc6376',
    section: '3.4.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Convert all sequences of one or more WSP characters to a single SP character.',
    testability: { kind: 'parse' },
    note:
      'Relaxed-header WSP collapse, applied after unfolding continuation lines — so ' +
      'a folded value becomes one line with single spaces. The ' +
      'relaxedHeaderKeepsWspRuns defect is the negative control, verified against ' +
      'the §3.4.5 Example 1 header vector ("b:Y Z").',
  },
  {
    id: 'R-6376-3.4.2-c',
    rfc: 'rfc6376',
    section: '3.4.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Delete all WSP characters at the end of each unfolded header field value.',
    testability: { kind: 'parse' },
    note:
      'Relaxed-header trailing-WSP strip (with the colon-adjacent WSP also deleted). ' +
      'The relaxedHeaderKeepsTrailingWsp defect is the negative control.',
  },
  {
    id: 'R-6376-3.4.3-a',
    rfc: 'rfc6376',
    section: '3.4.3',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The "simple" body canonicalization algorithm ignores all empty lines at the end of the message body.',
    testability: { kind: 'parse' },
    note:
      'Simple body: reduce a run of trailing CRLFs to a single CRLF; a completely ' +
      'empty body canonicalizes to one CRLF (2 octets). The ' +
      'simpleBodyKeepsTrailingBlankLines defect is the negative control.',
  },
  {
    id: 'R-6376-3.4.4-a',
    rfc: 'rfc6376',
    section: '3.4.4',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Ignore all whitespace at the end of lines.',
    testability: { kind: 'parse' },
    note:
      'First relaxed-body step (with intra-line WSP-run collapse as the second, and ' +
      'trailing-empty-line removal as step b). Verified against the §3.4.5 Example 1 ' +
      'body vector (" C" / "D E"). The relaxedBodyKeepsLineTrailingWsp defect is the ' +
      'negative control. MUST NOT remove the CRLF itself.',
  },
] as const satisfies readonly RequirementDef[];
