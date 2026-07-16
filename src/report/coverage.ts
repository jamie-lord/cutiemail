/**
 * The coverage report: the artifact that makes the project's central claim
 * checkable.
 *
 * The claim is "we know what has been implemented, what works, and why." This
 * report is where that is either true or exposed as false. For every requirement
 * in the register it answers: is there a test, a deliberate decision not to
 * test, or an untestable-reason — and for wire-testable requirements with a
 * test, is there a NEGATIVE CONTROL proving the test can actually detect the
 * violation?
 *
 * Two anti-flattery rules are baked in, because a coverage report's failure mode
 * is making things look better than they are:
 *
 * 1. **The denominator is honest.** It is the count of requirements the register
 *    ACTUALLY HOLDS, and the report states how much of RFC 5321 the register has
 *    even been extracted from (via EXTRACTED_SECTIONS). A percentage computed
 *    against a half-extracted register would flatter us by shrinking the
 *    denominator invisibly. So the report always shows both "of extracted" and a
 *    loud note about what is unextracted.
 *
 * 2. **A test without a negative control is half-covered, not covered.** A
 *    conformance test that has never been shown to FAIL against a broken server
 *    is faith, not evidence (see the fabricated-quote incident for how confident
 *    wrongness looks). Wire-testable requirements are only "fully covered" once a
 *    mutant proves the test has teeth.
 */

import { REQUIREMENTS, EXTRACTED_SECTIONS } from '../register/rfc5321.ts';
import type { RequirementDef } from '../register/types.ts';
import type { TestCase, Mutant } from '../conformance/test-case.ts';

export type CoverageState =
  /** Wire-testable, has a test AND a passing negative control. */
  | 'fully-covered'
  /** Wire-testable, has a test but no negative control proving it detects. */
  | 'test-only'
  /** Needs a fixture; has a test that will run when the fixture is supplied. */
  | 'fixture-gated'
  /** Testable, deliberately not covered, with a recorded reason. */
  | 'deliberately-uncovered'
  /** Not testable by this suite, with a recorded reason. */
  | 'not-testable'
  /** Testable, no test, no decision. THE gap the report exists to surface. */
  | 'uncovered';

export interface RequirementCoverage {
  readonly id: string;
  readonly section: string;
  readonly level: RequirementDef['level'];
  readonly party: RequirementDef['party'];
  readonly state: CoverageState;
  readonly testIds: readonly string[];
  readonly hasMutant: boolean;
  /** For not-testable / deliberately-uncovered: the recorded reason. */
  readonly reason?: string;
}

export interface CoverageReport {
  readonly generatedFrom: {
    readonly requirementCount: number;
    readonly extractedSections: readonly string[];
    readonly testCount: number;
    readonly mutantCount: number;
  };
  readonly byState: Readonly<Record<CoverageState, number>>;
  readonly requirements: readonly RequirementCoverage[];
  /** Requirements in an actionable-gap state, most-actionable first. */
  readonly gaps: readonly RequirementCoverage[];
  /** Tests citing a requirement not in the register — should be impossible via
   *  the type system, but checked at runtime in case data is edited by hand. */
  readonly orphanTests: readonly string[];
}

function stateOf(
  req: RequirementDef,
  tests: readonly TestCase[],
  mutants: readonly Mutant[],
  latitudeControlled: ReadonlySet<string>,
): CoverageState {
  if (req.testability.kind === 'not-testable') return 'not-testable';
  if (req.deliberatelyUncovered !== undefined) return 'deliberately-uncovered';

  if (tests.length === 0) {
    return req.testability.kind === 'wire-with-fixture' ? 'uncovered' : 'uncovered';
  }
  if (req.testability.kind === 'wire-with-fixture') return 'fixture-gated';

  const testIds = new Set(tests.map((t) => t.id));
  // A SHOULD/MAY tested via a latitude control is fully covered: the control
  // proves it classifies both ways (conformant vs permitted-latitude). Such a
  // requirement can never have a violation-catching mutant, so demanding one
  // would wrongly mark it half-covered.
  if ([...testIds].some((id) => latitudeControlled.has(id))) return 'fully-covered';
  // wire + tests: otherwise covered only if a mutant proves at least one test detects.
  const hasProvenMutant = mutants.some((m) => testIds.has(m.catches));
  return hasProvenMutant ? 'fully-covered' : 'test-only';
}

/**
 * Compute coverage from the register, the corpus, and the mutants.
 *
 * `tests` is every TestCase in the corpus; `mutants` every negative control. A
 * test contributes to a requirement if it is the primary `requirement` OR in
 * `alsoTouches` — but only the primary counts toward that requirement having a
 * proving mutant, since a mutant is written to catch a specific test's specific
 * check.
 */
export function computeCoverage(
  tests: readonly TestCase[],
  mutants: readonly Mutant[],
  latitudeControlledCaseIds: readonly string[] = [],
): CoverageReport {
  const reqs = REQUIREMENTS as readonly RequirementDef[];
  const ids = new Set(reqs.map((r) => r.id));
  const latitudeControlled = new Set(latitudeControlledCaseIds);

  const testsByReq = new Map<string, TestCase[]>();
  const orphanTests: string[] = [];
  for (const t of tests) {
    const targets = [t.requirement, ...(t.alsoTouches ?? [])];
    for (const target of targets) {
      if (!ids.has(target)) {
        orphanTests.push(`${t.id} -> ${target}`);
        continue;
      }
      const arr = testsByReq.get(target) ?? [];
      arr.push(t);
      testsByReq.set(target, arr);
    }
  }

  const requirements: RequirementCoverage[] = reqs.map((req) => {
    const reqTests = testsByReq.get(req.id) ?? [];
    const state = stateOf(req, reqTests, mutants, latitudeControlled);
    const testIds = reqTests.map((t) => t.id);
    const hasMutant = mutants.some((m) => testIds.includes(m.catches));
    const reason =
      req.testability.kind === 'not-testable'
        ? req.testability.reason
        : req.deliberatelyUncovered?.reason;
    return {
      id: req.id,
      section: req.section,
      level: req.level,
      party: req.party,
      state,
      testIds,
      hasMutant,
      ...(reason !== undefined ? { reason } : {}),
    };
  });

  const byState: Record<CoverageState, number> = {
    'fully-covered': 0,
    'test-only': 0,
    'fixture-gated': 0,
    'deliberately-uncovered': 0,
    'not-testable': 0,
    uncovered: 0,
  };
  for (const r of requirements) byState[r.state]++;

  // Gaps ranked: an outright uncovered testable requirement is the most
  // actionable; a test-only (needs a mutant) next; fixture-gated last since it
  // is waiting on infrastructure, not authoring.
  const rank: Partial<Record<CoverageState, number>> = {
    uncovered: 0,
    'test-only': 1,
    'fixture-gated': 2,
  };
  const gaps = requirements
    .filter((r) => r.state in rank)
    .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));

  return {
    generatedFrom: {
      requirementCount: reqs.length,
      extractedSections: EXTRACTED_SECTIONS,
      testCount: tests.length,
      mutantCount: mutants.length,
    },
    byState,
    requirements,
    gaps,
    orphanTests,
  };
}

/** A plain-text rendering. The first thing a reader of the repo should see. */
export function renderCoverage(report: CoverageReport): string {
  const g = report.generatedFrom;
  const lines: string[] = [
    'RFC 5321 CONFORMANCE COVERAGE',
    '='.repeat(60),
    '',
    `Register holds ${g.requirementCount} requirements from ${g.extractedSections.length} extracted sections.`,
    `Corpus: ${g.testCount} tests, ${g.mutantCount} negative controls.`,
    '',
    'IMPORTANT: the denominator is requirements EXTRACTED so far, not all of',
    'RFC 5321. Sections not yet extracted are absent entirely — this is a floor',
    'on coverage, not a ceiling. Extracted sections:',
    `  ${g.extractedSections.join(', ')}`,
    '',
    'By state:',
    `  fully-covered           ${report.byState['fully-covered']}   (test + proven negative control)`,
    `  test-only               ${report.byState['test-only']}   (test, but NO proof it detects — half-covered)`,
    `  fixture-gated           ${report.byState['fixture-gated']}   (needs operator-declared server state)`,
    `  deliberately-uncovered  ${report.byState['deliberately-uncovered']}   (a recorded decision)`,
    `  not-testable            ${report.byState['not-testable']}   (client-binding or unobservable, with reason)`,
    `  uncovered               ${report.byState.uncovered}   (testable, no test, no decision — THE gaps)`,
  ];

  if (report.orphanTests.length > 0) {
    lines.push('', 'ORPHAN TESTS (cite a requirement not in the register):');
    for (const o of report.orphanTests) lines.push(`  ! ${o}`);
  }

  if (report.gaps.length > 0) {
    lines.push('', `Top gaps (${report.gaps.length}):`);
    for (const gap of report.gaps.slice(0, 25)) {
      lines.push(`  [${gap.state}] ${gap.id} (${gap.level}, ${gap.party})`);
    }
    if (report.gaps.length > 25) lines.push(`  ... and ${report.gaps.length - 25} more`);
  }

  return lines.join('\n');
}
