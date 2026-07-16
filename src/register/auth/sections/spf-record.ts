/**
 * RFC 7208 — Sender Policy Framework (the record syntax + evaluation order)
 *
 * Inbound sender authorization: does the connecting IP's domain permit it to send?
 * The subtle, security-load-bearing parts that a parser/evaluator can pin down
 * without DNS are the version gate (a "v=spf10" record must be discarded, not
 * treated as spf1), the strict left-to-right first-match evaluation, and the
 * qualifier semantics (+/-/~/? and the "+" default). Getting first-match or a
 * qualifier wrong flips an authorization decision, so each is negative-controlled.
 *
 * Verbatim quotes from spec/rfc7208.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SPF_RECORD = [
  {
    id: 'R-7208-4.5-a',
    rfc: 'rfc7208',
    section: '4.5',
    page: 14,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'discard records that do not begin with a version section of exactly "v=spf1".',
    testability: { kind: 'parse' },
    note:
      'The version gate: only a record starting with exactly "v=spf1" (terminated by ' +
      'SP or end) is an SPF record. "v=spf10" is NOT a match and is discarded. Our ' +
      'parser rejects a non-"v=spf1" version; the acceptAnyVersion defect is the ' +
      'negative control — treating "v=spf10" as spf1 would apply the wrong policy.',
  },
  {
    id: 'R-7208-4.6.2-a',
    rfc: 'rfc7208',
    section: '4.6.2',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Each mechanism is considered in turn from left to right.',
    testability: { kind: 'parse' },
    note:
      'First-match wins: evaluation stops at the first mechanism that matches and ' +
      'returns its qualifier. Order is load-bearing — "a -all" and "-all a" mean ' +
      'different things. Our evaluator walks left to right and returns on first ' +
      'match; the lastMatchWins defect (evaluate right to left) is the negative ' +
      'control.',
  },
  {
    id: 'R-7208-4.6.2-b',
    rfc: 'rfc7208',
    section: '4.6.2',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The qualifier is optional and defaults to "+".',
    testability: { kind: 'parse' },
    note:
      'Qualifier semantics: "+" pass, "-" fail, "~" softfail, "?" neutral; absent ' +
      'means "+". So a bare "mx" authorises (pass) on match. Our parser assigns the ' +
      'default "+"; the defaultQualifierNeutral defect (default to neutral) is the ' +
      'negative control — it would silently downgrade an authorising record.',
  },
] as const satisfies readonly RequirementDef[];
