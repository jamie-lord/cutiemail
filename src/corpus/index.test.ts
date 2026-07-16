import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CASES, ALL_MUTANTS, LATITUDE_CONTROLLED_IDS, duplicateCaseIds } from './index.ts';
import { REQUIREMENTS, requirement } from '../register/rfc5321.ts';
import type { RequirementDef } from '../register/types.ts';
import { computeCoverage } from '../report/coverage.ts';

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
// The corpus->register citation contract for a case's OWN requirement.
//
// The runner grades the server against `tc.requirement`'s level with no runtime
// party or testability check — it trusts the corpus to only cite requirements a
// server is bound by and that are observable on the wire. If a case cited a
// CLIENT-party requirement and returned `violated`, the runner would report the
// SERVER non-conformant for a rule that does not bind it: a false accusation, the
// one thing this suite must never make. If a case cited a NOT-TESTABLE
// requirement, coverage.ts would silently report it not-testable (stateOf checks
// that first) while the test quietly graded it anyway — a contradiction hidden
// from the report. Neither is possible today; this makes it impossible to
// introduce. alsoTouches is held to the same bar: a wire test cannot "touch" on
// the wire something the register says is unobservable there.
test('every case cites a non-client, testable requirement (primary and alsoTouches)', () => {
  for (const c of ALL_CASES) {
    const targets = [
      [c.requirement, true] as const,
      ...(c.alsoTouches ?? []).map((t) => [t, false] as const),
    ];
    for (const [id, isPrimary] of targets) {
      const where = isPrimary ? 'primary requirement' : 'alsoTouches';
      const def = requirement(id);
      assert.notEqual(
        def.party,
        'client',
        `case ${c.id} cites client-bound ${id} as its ${where}; a server cannot be graded against a client requirement`,
      );
      assert.notEqual(
        def.testability.kind,
        'not-testable',
        `case ${c.id} cites not-testable ${id} as its ${where}; a wire test must not claim to cover an unobservable requirement`,
      );
    }
  }
});

// The headline claim, made executable.
//
// The README and the coverage report assert that every wire-testable MUST is
// either covered by a proven negative control or carries a recorded decision —
// "no silent gaps". That is the whole trust story, and until now it was
// guaranteed only by prose and a manual read of the coverage output. So it could
// rot exactly like the compliance tables this project exists to distrust: add a
// MUST to the register, delete a mutant, reclassify a requirement, and the claim
// quietly becomes false with nothing failing.
//
// This is that claim as an invariant. A strict (MUST/MUST NOT/REQUIRED),
// server-observable, PLAIN-wire requirement (kind 'wire' — not fixture-gated,
// which is a distinct honest state, and not not-testable) may only be
// 'fully-covered' (test + proven mutant) or 'deliberately-uncovered' (a recorded
// decision). It may NEVER be 'uncovered' (no test, no decision — a silent gap) or
// 'test-only' (a test never shown to have teeth). If this test fails, the
// project's central promise is no longer true; fix the coverage, not the test.
test('no strict wire-testable MUST is a silent gap (the headline coverage claim)', () => {
  const report = computeCoverage(ALL_CASES, ALL_MUTANTS, LATITUDE_CONTROLLED_IDS);
  const defById = new Map<string, RequirementDef>(
    (REQUIREMENTS as readonly RequirementDef[]).map((d) => [d.id, d]),
  );
  const offenders = report.requirements.filter((r) => {
    const def = defById.get(r.id)!;
    const strict = def.level === 'MUST' || def.level === 'MUST NOT' || def.level === 'REQUIRED';
    const observable = def.party !== 'client';
    const plainWire = def.testability.kind === 'wire';
    return strict && observable && plainWire && (r.state === 'uncovered' || r.state === 'test-only');
  });
  assert.deepEqual(
    offenders.map((r) => `${r.id} [${r.state}]`),
    [],
    'a strict, observable, plain-wire MUST is a silent gap — it must be fully-covered ' +
      'by a proven negative control or carry a deliberatelyUncovered decision',
  );
});

// Citation drift backstop: a test citing a requirement absent from the register
// is caught at runtime (orphanTests). The type system should prevent it, but the
// register and corpus are edited by hand, so the report surfaces it and this
// pins it to zero — an orphan means a coverage number computed against a mistyped
// id, silently crediting or dropping a requirement.
test('no corpus test cites a requirement outside the register (no orphans)', () => {
  const report = computeCoverage(ALL_CASES, ALL_MUTANTS, LATITUDE_CONTROLLED_IDS);
  assert.deepEqual(report.orphanTests, [], 'a test cites a requirement id not in the register');
});

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
