/**
 * The date-time (RFC 5322 §3.3) conformance corpus, with negative controls.
 *
 * Proves the opinionated parser accepts the modern numeric date-time, enforces
 * semantic validity (not just syntax), and rejects the obsolete tail — and that
 * every rejection is a REAL detection (the matching defect that accepts the bad
 * value is caught). Cases cite compile-checked MessageRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from './date.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const d = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

test('sanity: modern date-time forms parse into components', () => {
  // With and without the optional day-name, with and without seconds.
  for (const s of [
    'Wed, 15 Jul 2026 09:30:00 +0100',
    '15 Jul 2026 09:30 +0000',
    'Wed, 15 Jul 2026 23:59:60 -0530', // leap second, negative offset
  ]) {
    assert.ok(parseDate(d(s)).ok, `${s} should parse`);
  }
  const r = parseDate(d('Wed, 15 Jul 2026 09:30:00 +0100'));
  assert.ok(r.ok);
  assert.equal(r.date.year, 2026);
  assert.equal(r.date.month, 7);
  assert.equal(r.date.day, 15);
  assert.equal(r.date.zoneMinutes, 60);
  assert.equal(r.date.dayOfWeek, 'Wed');
});

test('R-5322-3.3-a: semantic validity is enforced beyond syntax (each check has a negative control)', () => {
  cites('R-5322-3.3-a');

  // day-of-month: 31 Feb is syntactically fine, semantically impossible.
  assert.ok(!parseDate(d('31 Feb 2026 09:00:00 +0000')).ok, '31 Feb is rejected');
  assert.ok(parseDate(d('31 Feb 2026 09:00:00 +0000'), { acceptBadDayOfMonth: true }).ok, 'acceptBadDayOfMonth must be detectable');
  // Leap-year awareness: 29 Feb exists in 2024, not in 2026.
  assert.ok(parseDate(d('29 Feb 2024 09:00:00 +0000')).ok, '29 Feb 2024 is a real leap day');
  assert.ok(!parseDate(d('29 Feb 2026 09:00:00 +0000')).ok, '29 Feb 2026 is not (not a leap year)');

  // time-of-day: hour/minute/second ranges.
  assert.ok(!parseDate(d('15 Jul 2026 25:00:00 +0000')).ok, 'hour 25 is rejected');
  assert.ok(!parseDate(d('15 Jul 2026 09:60:00 +0000')).ok, 'minute 60 is rejected');
  assert.ok(parseDate(d('15 Jul 2026 25:00:00 +0000'), { acceptBadTimeOfDay: true }).ok, 'acceptBadTimeOfDay must be detectable');

  // zone minutes: the trailing two digits are 00-59.
  assert.ok(!parseDate(d('15 Jul 2026 09:00:00 +0099')).ok, 'zone minutes 99 is rejected');
  assert.ok(parseDate(d('15 Jul 2026 09:00:00 +0099'), { acceptBadZoneMinutes: true }).ok, 'acceptBadZoneMinutes must be detectable');
});

test('R-5322-3.3-b: the day-of-week must match the date (mismatch rejected, defect caught)', () => {
  cites('R-5322-3.3-b');
  // 15 Jul 2026 is a Wednesday; claiming Tuesday is a lie.
  assert.ok(parseDate(d('Wed, 15 Jul 2026 09:00:00 +0000')).ok, 'the true weekday is accepted');
  assert.ok(!parseDate(d('Tue, 15 Jul 2026 09:00:00 +0000')).ok, 'a contradicting weekday is rejected');
  assert.ok(parseDate(d('Tue, 15 Jul 2026 09:00:00 +0000'), { acceptWeekdayMismatch: true }).ok, 'acceptWeekdayMismatch must be detectable');
});

test('R-5322-3.3-c: an obsolete 2-digit year is rejected (modern 4-digit cut, defect caught)', () => {
  cites('R-5322-3.3-c');
  assert.ok(!parseDate(d('15 Jul 26 09:00:00 +0000')).ok, 'a 2-digit obs-year is rejected');
  assert.ok(parseDate(d('15 Jul 26 09:00:00 +0000'), { acceptObsYear: true }).ok, 'acceptObsYear must be detectable');
  assert.ok(!parseDate(d('15 Jul 1899 09:00:00 +0000')).ok, 'a year before 1900 is rejected');
});

test('opinionated cut: the alphabetic obs-zone and CFWS comments are rejected outright', () => {
  cites('R-5322-3.3-a');
  // obs-zone: "GMT"/"UT"/military single letters are rejected — numeric offset only.
  assert.ok(!parseDate(d('15 Jul 2026 09:00:00 GMT')).ok, 'the "GMT" obs-zone is rejected');
  assert.ok(!parseDate(d('15 Jul 2026 09:00:00 EST')).ok, 'the "EST" obs-zone is rejected');
  // CFWS/comment inside the date is the obsolete form — rejected, not stripped.
  assert.ok(!parseDate(d('15 Jul 2026 09:00:00 +0000 (UTC)')).ok, 'a trailing comment is rejected');
});

test('-0000 (time generated with no local-zone info) parses and is surfaced as an anomaly', () => {
  cites('R-5322-3.3-a');
  const r = parseDate(d('15 Jul 2026 09:00:00 -0000'));
  assert.ok(r.ok && r.date.zoneMinutes === 0, '-0000 is Universal Time (offset 0)');
  assert.ok(r.ok && r.date.anomalies.includes('minus-zero-zone'), 'the "no local zone" marker is surfaced');
});
