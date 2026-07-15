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
import { CASES as seqCases, MUTANTS as seqMutants } from './session-sequencing.ts';
import { CASES as sizeCases, MUTANTS as sizeMutants } from './size-limits.ts';
import { CASES as errCases, MUTANTS as errMutants } from './error-handling.ts';
import { CASES as txnCases, MUTANTS as txnMutants } from './mail-transaction.ts';
import { CASES as extCases, MUTANTS as extMutants } from './extensions.ts';
import { CASES as connCases, MUTANTS as connMutants } from './connection.ts';
import { CASES as minCases, MUTANTS as minMutants } from './minimum-implementation.ts';
import { CASES as replyCases, MUTANTS as replyMutants } from './reply-structure.ts';
import { CASES as bufCases, MUTANTS as bufMutants } from './command-buffer-effects.ts';
import { CASES as termCases, MUTANTS as termMutants } from './termination.ts';
import { CASES as syntaxCases, MUTANTS as syntaxMutants } from './syntax-case.ts';

export const ALL_CASES: readonly TestCase[] = [
  ...connCases,
  ...minCases,
  ...crlfCases,
  ...seqCases,
  ...sizeCases,
  ...errCases,
  ...txnCases,
  ...extCases,
  ...replyCases,
  ...bufCases,
  ...termCases,
  ...syntaxCases,
];

export const ALL_MUTANTS: readonly Mutant[] = [
  ...connMutants,
  ...minMutants,
  ...crlfMutants,
  ...seqMutants,
  ...sizeMutants,
  ...errMutants,
  ...txnMutants,
  ...extMutants,
  ...replyMutants,
  ...bufMutants,
  ...termMutants,
  ...syntaxMutants,
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
