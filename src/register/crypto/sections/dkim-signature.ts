/**
 * RFC 6376 §3.5 — The DKIM-Signature Header Field (tag-list structure)
 *
 * The tag-list that tells a verifier how to check a signature: v/a/b/bh/d/s/h and
 * friends. Before any crypto runs, the tag-list itself must be well-formed — a
 * duplicate tag invalidates it, required tags must be present, and unknown tags are
 * ignored (but still covered by the signature). These are the parse-level gates
 * that decide whether verification even begins, so they are negative-controlled.
 *
 * This section is tag-list structure only; the actual signature and body-hash
 * verification (over the §3.4 canonicalized output) is a later increment.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_SIGNATURE = [
  {
    id: 'R-6376-3.5-a',
    rfc: 'rfc6376',
    section: '3.5',
    page: 21,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Tags with duplicate names MUST NOT occur within a single tag-list; if a tag name does occur more than once, the entire tag-list is invalid.',
    testability: { kind: 'parse' },
    note:
      'A duplicate tag is not a last-wins merge — it invalidates the whole ' +
      'signature. Our parser rejects a tag-list with any repeated tag; the ' +
      'acceptDuplicateTags defect (last-wins instead) is the negative control. ' +
      'Silently merging duplicates is a signature-substitution vector.',
  },
  {
    id: 'R-6376-3.5-b',
    rfc: 'rfc6376',
    section: '3.5',
    page: 25,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Unknown tags in the DKIM-Signature header field MUST be included in the signature calculation but MUST be otherwise ignored',
    testability: { kind: 'parse' },
    note:
      'Forward compatibility: an unrecognised tag must not stop verification — it is ' +
      'covered by the signature (so it cannot be tampered with) but otherwise ' +
      'ignored. Our parser keeps the unknown tag and stays valid; the ' +
      'failOnUnknownTag defect is the negative control.',
  },
  {
    id: 'R-6376-3.5-c',
    rfc: 'rfc6376',
    section: '3.5',
    page: 21,
    level: 'REQUIRED',
    party: 'both',
    normativeSource: 'keyword',
    text: 'v= Version (plain-text; REQUIRED).',
    testability: { kind: 'parse' },
    note:
      'The required tag set is v, a, b, bh, d, s, and h (each marked REQUIRED in ' +
      '§3.5). A signature missing any of them cannot be verified and is invalid. Our ' +
      'parser checks all seven are present (v quoted here as the exemplar); the ' +
      'acceptMissingRequiredTag defect (tolerate a missing required tag) is the ' +
      'negative control.',
  },
] as const satisfies readonly RequirementDef[];
