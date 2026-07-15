/**
 * The shared negative-control harness.
 *
 * Every corpus module proves the same two things about each case: it is
 * CONFORMANT against a clean server, and NON-CONFORMANT against a server carrying
 * exactly the defect the case is meant to catch. This factors that loop out so a
 * module's test file is a single call, and so the discipline cannot be quietly
 * skipped — a module that does not call this has no negative-control coverage,
 * and its wire requirements show as `test-only` in the coverage report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { baselineFixture } from '../conformance/fixture.ts';
import type { Fixture } from '../conformance/fixture.ts';
import { withMutant } from '../testing/mutant-server.ts';
import type { Defects } from '../testing/mutant-server.ts';
import type { TestCase, Mutant } from '../conformance/test-case.ts';

/** A fixture rich enough for any corpus case; harmless where unused. */
export const richFixture: Fixture = {
  ...baselineFixture('conformance-suite.invalid'),
  validRecipient: 'recipient@example.com',
  rejectedRecipient: 'nobody@example.com',
  nonRelayDomain: 'not-served.example.org',
  postmaster: 'postmaster@example.com',
  declaredSizeLimit: 10_485_760,
  source: 'operator-declared',
};

const VALID_RECIPIENTS = ['recipient@example.com'];

function defectFor(name: string): Defects {
  return { [name]: true } as Defects;
}

/**
 * Register the standard negative-control tests for a corpus module.
 *
 * For each mutant: the caught case must not be a finding against a clean server,
 * and must be a finding against the defect. Also asserts every case in the module
 * has a mutant — a wire case without one is only half a test.
 */
export function verifyNegativeControls(
  moduleName: string,
  cases: readonly TestCase[],
  mutants: readonly Mutant[],
): void {
  const byId = new Map(cases.map((c) => [c.id, c]));

  for (const mutant of mutants) {
    const tc = byId.get(mutant.catches);

    test(`${moduleName}: ${mutant.catches} — clean server is not a finding`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      await withMutant({ validRecipients: VALID_RECIPIENTS }, async (port) => {
        const result = await runCase(tc, {
          connect: { host: '127.0.0.1', port },
          fixture: richFixture,
        });
        assert.notEqual(
          result.outcome,
          'non-conformant',
          `clean server flagged as a finding: ` +
            `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
        );
        assert.ok(
          result.outcome === 'conformant' || result.outcome === 'inconclusive',
          `expected conformant/inconclusive on clean server, got ${result.outcome}`,
        );
      });
    });

    test(`${moduleName}: ${mutant.catches} — catches defect "${mutant.defect}"`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      await withMutant(
        { defects: defectFor(mutant.defect), validRecipients: VALID_RECIPIENTS },
        async (port) => {
          const result = await runCase(tc, {
            connect: { host: '127.0.0.1', port },
            fixture: richFixture,
          });
          assert.equal(
            result.outcome,
            'non-conformant',
            `defect ${mutant.defect} not caught by ${mutant.catches}: got ${result.outcome} ` +
              `(${result.judgement.kind === 'inconclusive' ? result.judgement.reason : ''})`,
          );
        },
      );
    });
  }

  test(`${moduleName}: every case has a negative control`, () => {
    const caught = new Set(mutants.map((m) => m.catches));
    for (const c of cases) {
      assert.ok(caught.has(c.id), `case ${c.id} has no mutant — it is only half a test`);
    }
  });
}
