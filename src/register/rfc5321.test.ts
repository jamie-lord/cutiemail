/**
 * Invariants for the requirement register.
 *
 * These are not ceremony. The register's whole value is that it can be trusted
 * as a faithful, complete-as-far-as-it-claims restatement of RFC 5321. Each test
 * here defends one of those properties — most importantly `text is verbatim`,
 * which is checked against the vendored RFC rather than taken on faith. Without
 * it, quotes drift into paraphrase, paraphrase drifts into interpretation, and
 * the register quietly becomes our opinion of the spec.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIREMENTS, EXTRACTED_SECTIONS } from './rfc5321.ts';
import type { RequirementDef } from './types.ts';

/**
 * `REQUIREMENTS` is `as const`, so its type is a union of literal object types —
 * great for narrowing RequirementId, awkward here: members that omit an optional
 * field don't carry it at all. These invariants care about the general shape, so
 * take a widened view.
 */
const requirements: readonly RequirementDef[] = REQUIREMENTS;
const extractedSections: readonly string[] = EXTRACTED_SECTIONS;

/**
 * RFC text with page furniture removed and all whitespace collapsed.
 *
 * The furniture has to go because requirement text runs across page breaks —
 * R-5321-2.4-i does exactly that — so a naive substring check would fail on
 * correctly-quoted text.
 */
const rfc: string = (() => {
  const raw = readFileSync(new URL('../../spec/rfc5321.txt', import.meta.url), 'utf8');
  return (
    raw
      .split('\n')
      .filter((line) => !/^Klensin\s+Standards Track\s+\[Page \d+\]$/.test(line))
      .filter((line) => !/^RFC 5321\s+SMTP\s+October 2008$/.test(line))
      .join('\n')
      // The RFC is wrapped to 72 columns and breaks at existing hyphens, so
      // "high-order" can appear as "high-\n   order". Rejoining is safe because
      // the text only ever breaks at a hyphen that is genuinely part of the
      // word — it never hyphenates to fit. Without this, a correct quote of
      // "high-order bit" fails against a literal "high- order bit".
      .replace(/-\n\s+/g, '-')
      .replace(/\f/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
})();

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

test('every requirement quotes RFC 5321 verbatim', () => {
  for (const r of requirements) {
    assert.ok(
      rfc.includes(collapse(r.text)),
      `${r.id} (§${r.section}) is not a verbatim quote from spec/rfc5321.txt.\n` +
        `Registered: ${collapse(r.text)}\n` +
        `Fix the quote — do not relax this test.`,
    );
  }
});

test('requirement ids are unique', () => {
  const seen = new Set<string>();
  for (const r of requirements) {
    assert.ok(!seen.has(r.id), `duplicate id: ${r.id}`);
    seen.add(r.id);
  }
});

test('requirement ids agree with the section they cite', () => {
  for (const r of requirements) {
    const expected = `R-5321-${r.section}-`;
    assert.ok(
      r.id.startsWith(expected),
      `${r.id} claims §${r.section}; id should start "${expected}"`,
    );
    assert.match(
      r.id,
      /^R-5321-[\d.]+-[a-z]{1,2}$/,
      `${r.id} does not match the R-5321-<section>-<letter> scheme`,
    );
  }
});

test('a requirement cannot be deliberately uncovered if it is not testable', () => {
  // "We chose not to test this" and "this cannot be tested" are different
  // claims. Conflating them would let an untestable requirement masquerade as a
  // considered decision, which is precisely the bookkeeping the register exists
  // to prevent.
  for (const r of requirements) {
    if (r.deliberatelyUncovered !== undefined) {
      assert.notEqual(
        r.testability.kind,
        'not-testable',
        `${r.id} is marked deliberately-uncovered but is also not-testable. ` +
          `Use the testability reason instead.`,
      );
    }
  }
});

test('every stated reason is substantive', () => {
  // A reason field containing "TODO" or three words is not a reason.
  for (const r of requirements) {
    if (r.testability.kind === 'not-testable') {
      assert.ok(
        r.testability.reason.length > 20,
        `${r.id}: not-testable needs a real reason, got "${r.testability.reason}"`,
      );
    }
    if (r.testability.kind === 'wire-with-fixture') {
      assert.ok(
        r.testability.fixture.length > 20,
        `${r.id}: wire-with-fixture needs a real fixture description`,
      );
    }
  }
});

test('every requirement belongs to a section claimed as extracted', () => {
  // The load-bearing direction: a requirement whose section is not in
  // EXTRACTED_SECTIONS means the denominator undercounts what has been read, and
  // the coverage report would mis-attribute it. This must always hold.
  const claimed = new Set(extractedSections);
  for (const s of new Set(requirements.map((r) => r.section))) {
    assert.ok(claimed.has(s), `§${s} has requirements but is not in EXTRACTED_SECTIONS`);
  }
});

test('a claimed section with zero requirements is backed by a sibling that has some', () => {
  // The reverse direction is NOT symmetric: a section can be read in full and
  // legitimately hold no normative requirement — §4.2.3 is a numeric table,
  // §2.2 and §4.3 are parent headers, §5.2 is short prose. So "claimed but
  // empty" is permitted. What must NOT happen is claiming a whole top-level
  // section (e.g. §7) as extracted while none of it has been processed.
  //
  // Self-maintaining guard: a zero-requirement claimed section is only allowed
  // if its top-level section (§N) has at least one requirement SOMEWHERE. That
  // proves §N was genuinely worked, not merely listed. A bare §7 claim with no
  // §7.x requirements anywhere fails this without any hardcoded section number.
  const present = new Set(requirements.map((r) => r.section));
  const topLevelsWithReqs = new Set([...present].map((s) => s.split('.')[0]));

  for (const s of extractedSections) {
    if (present.has(s)) continue; // has its own requirements — fine
    const top = s.split('.')[0]!;
    assert.ok(
      topLevelsWithReqs.has(top),
      `§${s} is claimed extracted but nothing in §${top} has any requirement — ` +
        `the whole section looks unprocessed`,
    );
  }
});
