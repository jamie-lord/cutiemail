/**
 * RFC 5322 §3.3 — Date and Time Specification
 *
 * The Date field every message carries. The register captures the RFC's own
 * requirements; the opinionated-modern cut (ADR 0007) lives in HOW our parser meets
 * them: we accept only the modern numeric form and reject the whole obsolete tail
 * (obs-year 2-digit years, the alphabetic obs-zone "UT"/"GMT"/military zones,
 * CFWS/comments inside the date). The RFC keeps those for backward compat; we do
 * not, and — for the military zones — RFC 5322 §4.3 itself concedes they were "so
 * wrongly defined" that nothing is lost by refusing them.
 *
 * The load-bearing requirement is semantic validity: syntactically-fine nonsense
 * like "31 Feb 2026" or "25:00" or a weekday that contradicts the date is
 * non-conformant, and our parser rejects it. Verbatim quotes from spec/rfc5322.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S3_3 = [
  {
    id: 'R-5322-3.3-a',
    rfc: 'rfc5322',
    section: '3.3',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'A date-time specification MUST be semantically valid.',
    testability: { kind: 'parse' },
    note:
      'The substance of §3.3. Beyond syntax, the value must MEAN a real instant: the ' +
      'numeric day-of-month within the month (leap-year aware), the time-of-day in ' +
      '00:00:00–23:59:60 (the 60 permits a leap second), and the zone minutes in 00–59. ' +
      'Our parser enforces each; the acceptBadDayOfMonth / acceptBadTimeOfDay / ' +
      'acceptBadZoneMinutes defects prove each check is a real detection, not decoration.',
  },
  {
    id: 'R-5322-3.3-b',
    rfc: 'rfc5322',
    section: '3.3',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'the day-of-week (if included) MUST be the day implied by the date',
    testability: { kind: 'parse' },
    note:
      'A distinct cross-check with its own algorithm: when the optional "day-name," ' +
      'prefix is present it must agree with the weekday the date computes to (we use ' +
      "Zeller's congruence — pure arithmetic, no Date dependency). \"Tue, 15 Jul 2026\" " +
      'is a lie — 15 Jul 2026 is a Wednesday — and is rejected. The acceptWeekdayMismatch ' +
      'defect is the negative control.',
  },
  {
    id: 'R-5322-3.3-c',
    rfc: 'rfc5322',
    section: '3.3',
    page: 14,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The year is any numeric year 1900 or later.',
    testability: { kind: 'parse' },
    note:
      'Prose that bounds the year. We meet it and go further per ADR 0007: the modern ' +
      'form is a 4-digit year, so a 2- or 3-digit obs-year is rejected (the acceptObsYear ' +
      'defect undoes that cut), and a value below 1900 is rejected outright.',
  },
  {
    id: 'R-5322-3.3-d',
    rfc: 'rfc5322',
    section: '3.3',
    page: 15,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The date and time-of-day SHOULD express local time.',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether the stated wall-clock is the sender\'s local time (versus UTC) is not ' +
        'observable from the bytes — the zone offset is present either way. A parser cannot ' +
        'distinguish a conformant local time from a non-conformant UTC-as-local one.',
    },
    note: 'Registered so the denominator is honest; genuinely unobservable to a parser.',
  },
  {
    id: 'R-5322-3.3-e',
    rfc: 'rfc5322',
    section: '3.3',
    page: 13,
    level: 'RECOMMENDED',
    party: 'both',
    normativeSource: 'keyword',
    text: 'it is RECOMMENDED that a single space be used in each place that FWS appears',
    testability: { kind: 'parse' },
    note:
      'The RFC recommends a single space where FWS may appear; ADR 0007 hardens this into ' +
      'our parser requiring single-space separation and rejecting the obsolete folding/CFWS ' +
      'forms in a date. Tested as parser behaviour (comments/CFWS are rejected).',
    deliberatelyUncovered: {
      reason:
        'A RECOMMENDED, not a MUST. Our parser already rejects CFWS in dates (covered under ' +
        '3.3-a\'s corpus), so a dedicated single-vs-multiple-space case would only re-assert ' +
        'the same tokenizer path. Revisit if the generator side needs its own assertion.',
      date: '2026-07-16',
    },
  },
] as const satisfies readonly RequirementDef[];
