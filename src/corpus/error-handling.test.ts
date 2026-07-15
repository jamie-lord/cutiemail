import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import { verifyNegativeControls, richFixture } from './negative-control.ts';
import { CASES, MUTANTS } from './error-handling.ts';

verifyNegativeControls('error-handling', CASES, MUTANTS);

test('error-handling: a 421-then-close on an unknown command is conformant, not a finding', async () => {
  // Regression for the second-pass finding: a shutting-down server that answers
  // an unknown command with 421 and then closes is exercising §3.8/§4.2.1
  // latitude, NOT violating R-5321-4.1.1.10-b. It must not be a finding.
  const tc = CASES.find((c) => c.id === 'connection-stays-open-after-error');
  assert.ok(tc !== undefined);
  await withMutant({ defects: { closeWithout421: false, shutdownWith421: true } }, async (port) => {
    const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture: richFixture });
    assert.notEqual(
      result.outcome,
      'non-conformant',
      `421-then-close must not be a finding, got ${result.outcome}: ` +
        `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
    );
  });
});
