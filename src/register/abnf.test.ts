/**
 * Tests for the §4.1.2/§4.1.3 ABNF extraction.
 *
 * The load-bearing checks: the productions-of-interest and text-constraints
 * cross-references resolve to real rule names (a compile-time union already
 * enforces this, but the test documents the intent), the caveat and constraint
 * data are actually populated, and — the anti-fabrication guard — the verbatim
 * strings really appear in the vendored RFC.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ABNF_RULES,
  PRODUCTIONS_OF_INTEREST,
  GRAMMAR_CAVEAT,
  TEXT_CONSTRAINTS,
} from './abnf.ts';

/** The vendored RFC, whitespace-collapsed for substring matching across wraps. */
const RFC_PATH = fileURLToPath(new URL('../../spec/rfc5321.txt', import.meta.url));
const RFC_COLLAPSED = readFileSync(RFC_PATH, 'utf8').replace(/\s+/g, ' ');

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

test('every rule has a name, a non-empty RHS, and a known section', () => {
  assert.ok(ABNF_RULES.length > 0, 'expected some rules');
  for (const r of ABNF_RULES) {
    assert.ok(r.name.length > 0, 'rule name must be non-empty');
    assert.ok(r.rule.trim().length > 0, `rule ${r.name} has empty RHS`);
    assert.ok(
      r.section === '4.1.2' || r.section === '4.1.3',
      `rule ${r.name} has unexpected section ${r.section}`,
    );
  }
});

test('rule names are unique', () => {
  const names = ABNF_RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, 'duplicate rule name');
});

test('PRODUCTIONS_OF_INTEREST all reference real rule names and carry a note', () => {
  const names = new Set(ABNF_RULES.map((r) => r.name));
  assert.ok(PRODUCTIONS_OF_INTEREST.length >= 6, 'expected the six flagged productions');
  for (const p of PRODUCTIONS_OF_INTEREST) {
    assert.ok(names.has(p.production), `unknown production ${p.production}`);
    assert.ok(p.boundaryNote.trim().length > 0, `${p.production} has no boundary note`);
  }
});

test('GRAMMAR_CAVEAT is populated and quotes §2.4 verbatim', () => {
  assert.ok(GRAMMAR_CAVEAT.length > 0);
  assert.ok(
    RFC_COLLAPSED.includes(collapse(GRAMMAR_CAVEAT)),
    'GRAMMAR_CAVEAT does not appear verbatim in spec/rfc5321.txt',
  );
});

test('TEXT_CONSTRAINTS is populated, cross-refs real rules, and quotes the RFC verbatim', () => {
  const names = new Set(ABNF_RULES.map((r) => r.name));
  assert.ok(TEXT_CONSTRAINTS.length >= 4, 'expected at least four text constraints');
  for (const c of TEXT_CONSTRAINTS) {
    assert.ok(c.binds.length > 0, `constraint in §${c.section} binds nothing`);
    for (const b of c.binds) {
      assert.ok(names.has(b), `constraint in §${c.section} binds unknown rule ${b}`);
    }
    assert.ok(c.kind === 'adds' || c.kind === 'requires', 'bad kind');
    assert.ok(c.note.trim().length > 0, `constraint in §${c.section} has no note`);
    assert.ok(
      RFC_COLLAPSED.includes(collapse(c.text)),
      `constraint text for §${c.section} does not appear verbatim in the RFC`,
    );
  }
});

test('both directions of the necessary-but-not-sufficient point are represented', () => {
  const kinds = new Set(TEXT_CONSTRAINTS.map((c) => c.kind));
  assert.ok(kinds.has('adds'), 'no constraint that forbids a grammar-legal input');
  assert.ok(kinds.has('requires'), 'no constraint that adds an unstateable demand');
});
