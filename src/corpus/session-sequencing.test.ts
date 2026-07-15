import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import { verifyNegativeControls, richFixture } from './negative-control.ts';
import { CASES, MUTANTS } from './session-sequencing.ts';

verifyNegativeControls('session-sequencing', CASES, MUTANTS);

test('session-sequencing: a multiline PROSE HELO banner is conformant, not an extended response', async () => {
  // Regression for the third-pass finding: the HELO test flagged any multiline
  // reply whose lines contained words as "EHLO-style", so "250 Have a nice day"
  // read as advertising a "HAVE" extension. A prose banner advertising NO
  // recognised extension keyword must not be a finding.
  const tc = CASES.find((c) => c.id === 'helo-not-given-extended-response');
  assert.ok(tc !== undefined);
  await withMutant({ defects: { multilineProseHelo: true } }, async (port) => {
    const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture: richFixture });
    assert.equal(
      result.outcome,
      'conformant',
      `a multiline prose HELO banner must be conformant, got ${result.outcome}: ` +
        `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
    );
  });
});
