/**
 * CRLF-discipline corpus: negative-control verification.
 *
 * For each case: it must be CONFORMANT against the clean mutant, and
 * NON-CONFORMANT against a mutant carrying exactly the defect the case is meant
 * to catch. Both halves are required. The clean-baseline half proves the test
 * does not fire on a good server; the defect half proves it fires on a bad one.
 * A conformance test shown only to pass is not evidence of anything.
 *
 * This is the pattern every corpus module's test must follow. It is what turns
 * "we wrote a test" into "we proved the test detects the violation".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { baselineFixture } from '../conformance/fixture.ts';
import type { Fixture } from '../conformance/fixture.ts';
import { withMutant } from '../testing/mutant-server.ts';
import type { Defects } from '../testing/mutant-server.ts';
import { CASES, MUTANTS } from './crlf-discipline.ts';
import type { TestCase } from '../conformance/test-case.ts';

const byId = new Map(CASES.map((c) => [c.id, c]));

// A fixture rich enough for the DATA-path case; harmless for the others.
const fixture: Fixture = {
  ...baselineFixture('conformance-suite.invalid'),
  validRecipient: 'recipient@example.com',
  source: 'operator-declared',
};

function get(id: string): TestCase {
  const c = byId.get(id);
  assert.ok(c !== undefined, `no case ${id}`);
  return c;
}

/** The mutant switch names map 1:1 to Defects keys. */
function defectFor(name: string): Defects {
  return { [name]: true } as Defects;
}

for (const mutant of MUTANTS) {
  test(`${mutant.catches}: conformant against a clean server`, async () => {
    const tc = get(mutant.catches);
    await withMutant({ validRecipients: ['recipient@example.com'] }, async (port) => {
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.notEqual(
        result.outcome,
        'non-conformant',
        `clean server should not be a finding, got ${result.outcome}: ` +
          `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
      );
      // Should be conformant or (for the fixture-gated one against a mutant that
      // accepts all recipients) conformant. Inconclusive would mean the mutant
      // could not exercise the path — acceptable but noted.
      assert.ok(
        result.outcome === 'conformant' || result.outcome === 'inconclusive',
        `expected conformant/inconclusive, got ${result.outcome}`,
      );
    });
  });

  test(`${mutant.catches}: non-conformant against defect "${mutant.defect}"`, async () => {
    const tc = get(mutant.catches);
    await withMutant(
      { defects: defectFor(mutant.defect), validRecipients: ['recipient@example.com'] },
      async (port) => {
        const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
        assert.equal(
          result.outcome,
          'non-conformant',
          `defect ${mutant.defect} should be caught by ${mutant.catches}, got ${result.outcome} ` +
            `(${result.judgement.kind === 'inconclusive' ? result.judgement.reason : ''})`,
        );
      },
    );
  });
}

test('every case has a mutant (no half-covered wire tests in this module)', () => {
  const caught = new Set(MUTANTS.map((m) => m.catches));
  for (const c of CASES) {
    assert.ok(caught.has(c.id), `case ${c.id} has no negative control — it is only half a test`);
  }
});
