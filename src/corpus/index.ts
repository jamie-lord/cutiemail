/**
 * The corpus: every conformance test case, collected.
 *
 * This is the single registry the runner and the coverage report read. A module
 * not spread in here is invisible — which the coverage report surfaces as
 * uncovered requirements, never as a silent pass.
 *
 * Modules are grouped by RFC concern, not by section, because a single behaviour
 * (dot-stuffing, CRLF discipline) is tested across the requirements it touches
 * rather than filed under one section number.
 */

import type { TestCase, Mutant } from '../conformance/test-case.ts';

import { CASES as crlfCases, MUTANTS as crlfMutants } from './crlf-discipline.ts';

export const ALL_CASES: readonly TestCase[] = [
  ...crlfCases,
];

export const ALL_MUTANTS: readonly Mutant[] = [
  ...crlfMutants,
];

/** Guard invoked by the corpus test: no two cases may share an id. */
export function duplicateCaseIds(): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const c of ALL_CASES) {
    if (seen.has(c.id)) dupes.push(c.id);
    seen.add(c.id);
  }
  return dupes;
}
