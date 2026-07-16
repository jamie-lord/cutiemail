/**
 * Coverage-report invariants.
 *
 * These defend the two anti-flattery rules: that a test without a negative
 * control counts as half-covered, and that the denominator never silently
 * shrinks. If either regresses, the report starts telling us the suite is more
 * complete than it is — the exact lie the report exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage, renderCoverage } from './coverage.ts';
import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { REQUIREMENTS } from '../register/rfc5321.ts';
import type { RequirementDef } from '../register/types.ts';

const noop = async (): Promise<Judgement> => ({ kind: 'satisfied' });

// Pick real requirements of known kinds so the test tracks the actual register.
const reqs = REQUIREMENTS as readonly RequirementDef[];
// These fixtures drive stateOf through the test/mutant scenarios below, so they
// must be requirements WITHOUT a deliberatelyUncovered decision — that field
// short-circuits stateOf to 'deliberately-uncovered' before any test/mutant is
// considered, which would make the scenario assertions meaningless.
const wireReq = reqs.find((r) => r.testability.kind === 'wire' && r.deliberatelyUncovered === undefined)!;
const fixtureReq = reqs.find((r) => r.testability.kind === 'wire-with-fixture' && r.deliberatelyUncovered === undefined);
const notTestableReq = reqs.find((r) => r.testability.kind === 'not-testable')!;

test('a wire requirement with a test but no mutant is test-only, not covered', () => {
  const tc = testCase({
    id: 'has-test',
    requirement: wireReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    run: noop,
  });
  const report = computeCoverage([tc], []);
  const cov = report.requirements.find((r) => r.id === wireReq.id)!;
  assert.equal(cov.state, 'test-only', 'a test without a proven negative control is not full coverage');
  assert.equal(report.byState['fully-covered'], 0);
});

test('a wire requirement with a test AND a catching mutant is fully-covered', () => {
  const tc = testCase({
    id: 'has-test-2',
    requirement: wireReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    run: noop,
  });
  const mutant: Mutant = { catches: 'has-test-2', defect: 'some-defect', why: 'violates the req' };
  const report = computeCoverage([tc], [mutant]);
  const cov = report.requirements.find((r) => r.id === wireReq.id)!;
  assert.equal(cov.state, 'fully-covered');
  assert.equal(cov.hasMutant, true);
});

test('a mutant catching a different test does not upgrade coverage', () => {
  const tc = testCase({
    id: 'has-test-3',
    requirement: wireReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    run: noop,
  });
  const mutant: Mutant = { catches: 'some-other-test', defect: 'd', why: 'w' };
  const report = computeCoverage([tc], [mutant]);
  assert.equal(report.requirements.find((r) => r.id === wireReq.id)!.state, 'test-only');
});

test('an alsoProves credit is anchored: a phantom or non-touching catch cannot over-credit', () => {
  const tc = testCase({
    id: 'anchored-primary',
    requirement: wireReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    run: noop,
  });

  // (1) A mutant that alsoProves wireReq but whose caught case does not exist.
  // The unanchored credit would flip wireReq to fully-covered on this alone.
  const phantom: Mutant = {
    catches: 'no-such-case',
    defect: 'd',
    why: 'w',
    alsoProves: [{ requirement: wireReq.id as TestCase['requirement'], why: 'bogus credit' }],
  };
  assert.equal(
    computeCoverage([tc], [phantom]).requirements.find((r) => r.id === wireReq.id)!.state,
    'test-only',
    'an alsoProves whose caught case does not exist must not credit the requirement',
  );

  // (2) A mutant that alsoProves wireReq and catches a REAL case — but one that
  // does not touch wireReq (different primary, no alsoTouches). Still no credit.
  const otherReq = reqs.find(
    (r) => r.id !== wireReq.id && r.testability.kind === 'wire' && r.deliberatelyUncovered === undefined,
  )!;
  const otherTc = testCase({
    id: 'other-case',
    requirement: otherReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    run: noop,
  });
  const nonTouching: Mutant = {
    catches: 'other-case',
    defect: 'd',
    why: 'w',
    alsoProves: [{ requirement: wireReq.id as TestCase['requirement'], why: 'bogus credit' }],
  };
  assert.equal(
    computeCoverage([tc, otherTc], [nonTouching]).requirements.find((r) => r.id === wireReq.id)!.state,
    'test-only',
    'an alsoProves whose caught case does not touch the requirement must not credit it',
  );
});

test('a not-testable requirement is reported as such, with its reason', () => {
  const report = computeCoverage([], []);
  const cov = report.requirements.find((r) => r.id === notTestableReq.id)!;
  assert.equal(cov.state, 'not-testable');
  assert.ok((cov.reason ?? '').length > 0, 'the recorded reason must surface in the report');
});

test('a fixture-gated requirement with a test is fixture-gated, not covered', () => {
  if (fixtureReq === undefined) return; // register may not yet have one extracted
  const tc = testCase({
    id: 'fixture-test',
    requirement: fixtureReq.id as TestCase['requirement'],
    intent: 'x',
    rationale: 'y',
    needs: { fixture: ['validRecipient'] },
    run: noop,
  });
  const report = computeCoverage([tc], []);
  assert.equal(report.requirements.find((r) => r.id === fixtureReq.id)!.state, 'fixture-gated');
});

test('a testable requirement with no test and no decision is an uncovered gap', () => {
  const report = computeCoverage([], []);
  const cov = report.requirements.find((r) => r.id === wireReq.id)!;
  assert.equal(cov.state, 'uncovered');
  assert.ok(report.gaps.some((gap) => gap.id === wireReq.id));
});

test('gaps are ranked uncovered before test-only before fixture-gated', () => {
  const report = computeCoverage([], []);
  let seenLater = false;
  for (const gap of report.gaps) {
    if (gap.state !== 'uncovered') seenLater = true;
    if (seenLater) assert.notEqual(gap.state, 'uncovered', 'all uncovered must sort before others');
  }
});

test('the denominator equals the register size — never silently shrunk', () => {
  const report = computeCoverage([], []);
  assert.equal(report.generatedFrom.requirementCount, REQUIREMENTS.length);
  const total = Object.values(report.byState).reduce((a, b) => a + b, 0);
  assert.equal(total, REQUIREMENTS.length, 'every requirement lands in exactly one state');
});

test('the rendering names the unextracted-sections caveat prominently', () => {
  const text = renderCoverage(computeCoverage([], []));
  assert.match(text, /EXTRACTED so far, not all of/);
  assert.match(text, /floor\non coverage, not a ceiling/);
});

test('an orphan test (hand-edited to cite a missing requirement) is flagged', () => {
  // Bypasses the type system the way a bad hand-edit would.
  const orphan = {
    id: 'orphan',
    requirement: 'R-5321-99.9-z',
    intent: 'x',
    rationale: 'y',
    run: noop,
  } as unknown as TestCase;
  const report = computeCoverage([orphan], []);
  assert.ok(report.orphanTests.some((o) => o.includes('R-5321-99.9-z')));
});
