import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CASES, ALL_MUTANTS, duplicateCaseIds } from './index.ts';

test('no two corpus cases share an id', () => {
  assert.deepEqual(duplicateCaseIds(), []);
});

test('every mutant references a real case', () => {
  const ids = new Set(ALL_CASES.map((c) => c.id));
  for (const m of ALL_MUTANTS) {
    assert.ok(ids.has(m.catches), `mutant catches unknown case: ${m.catches}`);
  }
});

test('every case id and intent is non-empty', () => {
  for (const c of ALL_CASES) {
    assert.ok(c.id.length > 0);
    assert.ok(c.intent.length > 10, `case ${c.id} needs a real intent`);
    assert.ok(c.rationale.length > 10, `case ${c.id} needs a real rationale`);
  }
});
