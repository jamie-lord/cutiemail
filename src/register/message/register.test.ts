/**
 * The message-format register's integrity gates — the same discipline the SMTP
 * register holds itself to, via the shared machinery in ../gate.ts.
 *
 * The load-bearing one is `verbatim`: every `text` must be a genuine substring of
 * its source RFC. Without it, "quoted from RFC 5322" is a claim, not a fact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_REQUIREMENTS, EXTRACTED_SECTIONS } from './index.ts';
import type { RequirementDef, Level } from '../types.ts';
import { collapse, loadSpec } from '../gate.ts';

const reqs = MESSAGE_REQUIREMENTS as readonly RequirementDef[];

/** RFC 2119 keyword families, base word -> the levels it can source. */
const KEYWORD: Record<string, Level[]> = {
  MUST: ['MUST', 'MUST NOT'],
  REQUIRED: ['REQUIRED'],
  SHALL: ['MUST', 'MUST NOT'],
  SHOULD: ['SHOULD', 'SHOULD NOT'],
  RECOMMENDED: ['RECOMMENDED'],
  MAY: ['MAY'],
};

test('every requirement quotes its source RFC verbatim', () => {
  for (const r of reqs) {
    const source = r.rfc ?? 'rfc5322';
    const quoted = collapse(r.text);
    assert.ok(quoted.length > 0, `${r.id} has empty text`);
    assert.ok(
      loadSpec(source).includes(quoted),
      `${r.id} (§${r.section}) is not a verbatim quote from spec/${source}.txt.\n` +
        `  looked for: ${JSON.stringify(quoted)}`,
    );
  }
});

test("a keyword-sourced requirement's level matches an RFC 2119 keyword in its text", () => {
  for (const r of reqs) {
    if (r.normativeSource !== 'keyword') continue;
    // Base-word match on word boundaries so the RFC's lower-case tails don't
    // false-match; a keyword-sourced level must have a keyword that can source it.
    const words = new Set(r.text.toUpperCase().match(/[A-Z]+/g) ?? []);
    const ok = Object.entries(KEYWORD).some(
      ([kw, levels]) => words.has(kw) && levels.includes(r.level),
    );
    assert.ok(
      ok,
      `${r.id} is normativeSource:'keyword' at level ${r.level} but no matching RFC 2119 keyword appears in its text`,
    );
  }
});

test('requirement ids are unique', () => {
  const seen = new Set<string>();
  for (const r of reqs) {
    assert.ok(!seen.has(r.id), `duplicate requirement id ${r.id}`);
    seen.add(r.id);
  }
});

test('requirement ids agree with the section and RFC they cite', () => {
  for (const r of reqs) {
    const rfcNum = (r.rfc ?? 'rfc5322').replace('rfc', '');
    const expected = `R-${rfcNum}-${r.section}-`;
    assert.ok(
      r.id.startsWith(expected),
      `${r.id} claims §${r.section} of ${r.rfc ?? 'rfc5322'}; id should start "${expected}"`,
    );
  }
});

test('a requirement cannot be deliberately uncovered if it is not testable', () => {
  for (const r of reqs) {
    if (r.deliberatelyUncovered !== undefined) {
      assert.notEqual(
        r.testability.kind,
        'not-testable',
        `${r.id} is both not-testable and deliberatelyUncovered — pick one`,
      );
    }
  }
});

test('every requirement belongs to a section claimed as extracted', () => {
  const claimed = new Set(EXTRACTED_SECTIONS);
  for (const r of reqs) {
    assert.ok(
      claimed.has(r.section),
      `${r.id} cites §${r.section}, which is not in EXTRACTED_SECTIONS`,
    );
  }
});
