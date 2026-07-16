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
import { REQUIREMENTS, EXTRACTED_SECTIONS } from './rfc5321.ts';
import type { RequirementDef } from './types.ts';
import { collapse, loadSpec } from './gate.ts';

/**
 * `REQUIREMENTS` is `as const`, so its type is a union of literal object types —
 * great for narrowing RequirementId, awkward here: members that omit an optional
 * field don't carry it at all. These invariants care about the general shape, so
 * take a widened view.
 */
const requirements: readonly RequirementDef[] = REQUIREMENTS;
const extractedSections: readonly string[] = EXTRACTED_SECTIONS;

// Spec loading + normalisation now lives in ./gate.ts, shared with the
// message-format register so both hold the same verbatim discipline.
test('every requirement quotes its source RFC verbatim', () => {
  for (const r of requirements) {
    const source = r.rfc ?? 'rfc5321';
    const quoted = collapse(r.text);
    // Guard the vacuous case FIRST: `"anything".includes("")` is always true, so
    // an empty (or whitespace-only) text would pass the verbatim check for the
    // wrong reason — a silent hole in the register's central integrity gate.
    assert.ok(
      quoted.length > 0,
      `${r.id} (§${r.section}) has empty requirement text; the verbatim check would ` +
        `pass vacuously. Every requirement must quote real spec text.`,
    );
    assert.ok(
      loadSpec(source).includes(quoted),
      `${r.id} (§${r.section}) is not a verbatim quote from spec/${source}.txt.\n` +
        `Registered: ${quoted}\n` +
        `Fix the quote — do not relax this test.`,
    );
  }
});

// A mis-declared level is the single register error that manufactures a FALSE
// FINDING: grade a server against `level` (runner.ts / outcome.ts), so a
// requirement the corpus convicts as a MUST that is really a SHOULD would report
// a conforming server non-conformant — the one accusation this suite must never
// make. The verbatim-quote gate proves the TEXT is faithful; this proves the
// LEVEL is faithful to that text. For every requirement whose normativity comes
// from an explicit RFC 2119 keyword (`normativeSource: 'keyword'`), the declared
// level's keyword family must actually appear in the quoted text. Requirements
// whose force is prose/structural (`normativeSource: 'prose'`) are exempt — their
// keyword lives elsewhere by design (e.g. R-5321-3.6.3-g inherits "this
// prohibition also applies").
test("a keyword-sourced requirement's level matches an RFC 2119 keyword in its text", () => {
  // Family per level: the uppercase base keyword(s) that legitimise it. Base-word
  // matching (\bMUST\b), not the full "MUST NOT" phrase, so the RFC's own
  // lower-case tails ("SHOULD not", R-5321-4.2.5-h) do not read as a mismatch —
  // the class digit comes from the base keyword, the negation from the "not".
  const family: Record<RequirementDef['level'], RegExp> = {
    MUST: /\bMUST\b|\bREQUIRED\b|\bSHALL\b/,
    'MUST NOT': /\bMUST\b|\bSHALL\b/,
    REQUIRED: /\bREQUIRED\b|\bMUST\b|\bSHALL\b/,
    SHOULD: /\bSHOULD\b|\bRECOMMENDED\b/,
    'SHOULD NOT': /\bSHOULD\b|\bRECOMMENDED\b/,
    RECOMMENDED: /\bRECOMMENDED\b|\bSHOULD\b/,
    MAY: /\bMAY\b|\bOPTIONAL\b/,
  };
  for (const r of requirements) {
    if (r.normativeSource !== 'keyword') continue;
    assert.match(
      r.text,
      family[r.level],
      `${r.id} is declared ${r.level} with normativeSource 'keyword', but no ${r.level} ` +
        `keyword appears in its verbatim text. Either the level is wrong (a false-finding ` +
        `risk) or the force is by prose reference — set normativeSource: 'prose'.`,
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
    // The id embeds the source RFC: R-5321-... for RFC 5321, R-3207-... for 3207.
    const rfcNum = (r.rfc ?? 'rfc5321').replace('rfc', '');
    const expected = `R-${rfcNum}-${r.section}-`;
    assert.ok(
      r.id.startsWith(expected),
      `${r.id} claims §${r.section} of ${r.rfc ?? 'rfc5321'}; id should start "${expected}"`,
    );
    assert.match(
      r.id,
      /^R-(5321|3207)-[\d.]+-[a-z]{1,2}$/,
      `${r.id} does not match the R-<rfc>-<section>-<letter> scheme`,
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
