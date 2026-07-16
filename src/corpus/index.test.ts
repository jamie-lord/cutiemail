import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CASES, ALL_MUTANTS, duplicateCaseIds } from './index.ts';
import { REQUIREMENTS } from '../register/rfc5321.ts';

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

// The alsoProves integrity guard. `alsoProves` lets one defect credit several
// requirements as fully-covered, so it is exactly the lever finding #6 warned
// could overstate coverage. Two invariants keep it honest:
//   1. Every alsoProves requirement must be a REAL register id (no phantom credit).
//   2. It must be a requirement the CAUGHT TEST actually bears on — its primary or
//      an alsoTouches. A mutant cannot conjure coverage for a requirement its test
//      never exercises; the claim is bounded by what the exchange actually touches.
// Together with the per-claim `why`, this makes alsoProves an auditable declaration
// rather than an escape hatch around the negative-control discipline.
test('every alsoProves claim is real and bounded by its caught test', () => {
  const registerIds = new Set(REQUIREMENTS.map((r) => r.id));
  const caseById = new Map(ALL_CASES.map((c) => [c.id, c]));
  for (const m of ALL_MUTANTS) {
    if (m.alsoProves === undefined) continue;
    const caught = caseById.get(m.catches);
    assert.ok(caught, `mutant on ${m.catches} has alsoProves but catches no known case`);
    const touched = new Set([caught.requirement, ...(caught.alsoTouches ?? [])]);
    for (const ap of m.alsoProves) {
      assert.ok(registerIds.has(ap.requirement), `alsoProves cites unknown requirement ${ap.requirement} (mutant on ${m.catches})`);
      assert.ok(
        touched.has(ap.requirement),
        `mutant on ${m.catches} alsoProves ${ap.requirement}, which its caught test neither has as primary nor alsoTouches — unbounded credit`,
      );
      assert.ok(ap.why.length > 10, `alsoProves ${ap.requirement} on ${m.catches} needs a real why`);
    }
  }
});
