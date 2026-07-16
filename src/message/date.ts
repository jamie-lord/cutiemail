/**
 * An opinionated, modern date-time parser/validator (RFC 5322 §3.3), with
 * switchable defects.
 *
 * Scope is the ADR-0007 cut. The RFC's grammar keeps a large obsolete tail —
 * obs-day-of-week, obs-year (2-digit years), obs-hour, obs-zone (the alphabetic
 * "UT"/"GMT"/"EST"/single-letter military zones), and CFWS/comments throughout.
 * We parse the ONE modern form real mail uses:
 *
 *     [ day-name "," ] SP day SP month SP 4*year SP hour ":" minute [ ":" second ] SP zone
 *
 * with `zone` the numeric "+hhmm" / "-hhmm" only. Every obsolete production is
 * rejected, not repaired — a date is a small, closed grammar and there is no
 * reason to carry 1982's ambiguities into a 2020s parser. The obsolete military
 * zones are the strongest case: RFC 5322 §4.3 itself notes they were "so wrongly
 * defined" that they SHOULD be treated as -0000, so refusing them loses nothing.
 *
 * The semantic-validity MUST (R-5322-3.3-a/-b) is the substance here: a
 * syntactically fine "31 Feb" or "25:00" or a weekday that contradicts the date
 * is non-conformant, and the defects below prove each of those checks is real.
 *
 * Bytes, never strings — but a date-time is pure printable ASCII by construction,
 * so we verify that (rejecting any 8-bit or control octet as a non-date) and then
 * work on the decoded token string. The decode is guarded, not blind.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface DateComponents {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly hour: number; // 0..23
  readonly minute: number; // 0..59
  readonly second: number; // 0..60 (60 permits a leap second, per §3.3)
  /** Signed offset from UTC in minutes, e.g. +0100 -> 60, -0530 -> -330. */
  readonly zoneMinutes: number;
  /** The stated day-of-week, if the optional "day-name," prefix was present. */
  readonly dayOfWeek?: string;
  /** Non-fatal observations (e.g. a -0000 "no local zone" marker). */
  readonly anomalies: readonly string[];
}

export type DateResult =
  | { readonly ok: true; readonly date: DateComponents }
  | { readonly ok: false; readonly reason: string };

export interface DateDefects {
  /** Skip the day-of-month range check (accept e.g. "31 Feb"). Violates R-5322-3.3-a. */
  readonly acceptBadDayOfMonth?: boolean;
  /** Skip the time-of-day range check (accept e.g. "25:00", "12:60"). Violates R-5322-3.3-a. */
  readonly acceptBadTimeOfDay?: boolean;
  /** Skip the zone-minutes range check (accept e.g. "+0099"). Violates R-5322-3.3-a. */
  readonly acceptBadZoneMinutes?: boolean;
  /** Skip the day-of-week cross-check (accept a weekday that contradicts the date). Violates R-5322-3.3-b. */
  readonly acceptWeekdayMismatch?: boolean;
  /** Accept an obs-year (fewer than 4 digits). Undoes the modern-4-digit cut of R-5322-3.3-c. */
  readonly acceptObsYear?: boolean;
}

/** Days in a month, Gregorian-leap-aware. month is 1..12. */
function daysInMonth(month: number, year: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Zeller's congruence (Gregorian). Returns the day-name for a Y/M/D. Pure arithmetic — no Date. */
function weekdayName(year: number, month: number, day: number): string {
  let m = month;
  let y = year;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h = (day + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  // h: 0=Sat, 1=Sun, 2=Mon, ... map to Mon-first names.
  return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][h]!;
}

/** Parse exactly N digits into a number, or null if the token is not N ASCII digits. */
function digits(tok: string, min: number, max: number): number | null {
  if (tok.length < min || tok.length > max) return null;
  if (!/^[0-9]+$/.test(tok)) return null;
  return Number(tok);
}

export function parseDate(input: Buffer, defects: DateDefects = {}): DateResult {
  // Guarded ASCII decode: a date-time is printable ASCII by construction, so any
  // 8-bit or control octet means this is not a date-time we will parse.
  for (const octet of input) {
    if (octet < 0x20 || octet > 0x7e) return { ok: false, reason: 'non-printable octet in date-time' };
  }
  const anomalies: string[] = [];
  let s = input.toString('latin1').trim();

  // Comments / CFWS are the obsolete form — reject rather than strip.
  if (s.includes('(') || s.includes(')')) return { ok: false, reason: 'comment/CFWS in date-time (obsolete form rejected)' };

  // Optional "day-name ,". Modern form uses a single following space.
  let dayOfWeek: string | undefined;
  const dow = /^([A-Za-z]{3}),\s+/.exec(s);
  if (dow !== undefined && dow !== null) {
    dayOfWeek = dow[1]!;
    if (!DAY_NAMES.includes(dayOfWeek)) return { ok: false, reason: `unknown day-of-week "${dayOfWeek}"` };
    s = s.slice(dow[0].length);
  }

  // day month year time zone — five whitespace-separated tokens.
  const tok = s.split(/\s+/);
  if (tok.length !== 5) return { ok: false, reason: `expected 5 date-time fields, found ${tok.length}` };
  const dayTok = tok[0]!;
  const monTok = tok[1]!;
  const yearTok = tok[2]!;
  const timeTok = tok[3]!;
  const zoneTok = tok[4]!;

  const day = digits(dayTok, 1, 2);
  if (day === null) return { ok: false, reason: `bad day-of-month "${dayTok}"` };

  const month = MONTHS.indexOf(monTok) + 1;
  if (month === 0) return { ok: false, reason: `unknown month "${monTok}"` };

  // year: modern form is 4+ digits (R-5322-3.3-c). obs-year (2-3 digits) only under defect.
  if (!/^[0-9]+$/.test(yearTok)) return { ok: false, reason: `bad year "${yearTok}"` };
  if (yearTok.length < 4 && defects.acceptObsYear !== true) {
    return { ok: false, reason: `obsolete ${yearTok.length}-digit year rejected (modern form is 4-digit)` };
  }
  const year = Number(yearTok);
  if (year < 1900 && defects.acceptObsYear !== true) return { ok: false, reason: 'year before 1900 (R-5322-3.3-c)' };

  // time-of-day: HH:MM or HH:MM:SS.
  const timeParts = timeTok.split(':');
  if (timeParts.length < 2 || timeParts.length > 3) return { ok: false, reason: `bad time-of-day "${timeTok}"` };
  const hour = digits(timeParts[0]!, 2, 2);
  const minute = digits(timeParts[1]!, 2, 2);
  const second = timeParts.length === 3 ? digits(timeParts[2]!, 2, 2) : 0;
  if (hour === null || minute === null || second === null) return { ok: false, reason: `bad time-of-day "${timeTok}"` };

  // zone: (+/-)HHMM only. The alphabetic obs-zone is rejected outright (the cut).
  const zm = /^([+-])([0-9]{2})([0-9]{2})$/.exec(zoneTok);
  if (zm === null) return { ok: false, reason: `non-numeric or malformed zone "${zoneTok}" (obs-zone rejected)` };
  const zoneHours = Number(zm[2]);
  const zoneMins = Number(zm[3]);
  const sign = zm[1] === '-' ? -1 : 1;
  if (zm[1] === '-' && zoneHours === 0 && zoneMins === 0) anomalies.push('minus-zero-zone'); // -0000: "no local zone info"
  const zoneMinutes = sign * (zoneHours * 60 + zoneMins);

  // --- Semantic validity (R-5322-3.3-a / -b): the substance. ---
  if (!defects.acceptBadDayOfMonth && (day < 1 || day > daysInMonth(month, year))) {
    return { ok: false, reason: `day-of-month ${day} out of range for ${monTok} ${year}` };
  }
  if (!defects.acceptBadTimeOfDay && (hour > 23 || minute > 59 || second > 60)) {
    return { ok: false, reason: `time-of-day ${timeTok} out of range` };
  }
  if (!defects.acceptBadZoneMinutes && zoneMins > 59) {
    return { ok: false, reason: `zone minutes ${zoneMins} out of range (00-59)` };
  }
  if (dayOfWeek !== undefined && !defects.acceptWeekdayMismatch) {
    const actual = weekdayName(year, month, day);
    if (actual !== dayOfWeek) {
      return { ok: false, reason: `day-of-week "${dayOfWeek}" contradicts the date (${monTok} ${day} ${year} is a ${actual})` };
    }
  }

  return {
    ok: true,
    date: {
      year,
      month,
      day,
      hour,
      minute,
      second,
      zoneMinutes,
      anomalies,
      ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
    },
  };
}
