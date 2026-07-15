import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import { verifyNegativeControls, richFixture } from './negative-control.ts';
import { CASES, MUTANTS } from './connection.ts';

verifyNegativeControls('connection', CASES, MUTANTS);

test('connection: a silent-but-open server is inconclusive on the greeting test, not a finding', async () => {
  // Regression for the fourth-pass finding: a server that is merely slow to send
  // its 220 (§4.5.3.2.1 permits a 5-minute wait) must NOT be convicted of a §3.1-a
  // MUST violation. Silent-forever is indistinguishable from slow within any
  // finite budget, so a timeout is inconclusive — the provable violation is a
  // CLOSE with no greeting (the closeOnConnect negative control), not silence.
  const tc = CASES.find((c) => c.id === 'greeting-is-sent-on-connect');
  assert.ok(tc !== undefined);
  await withMutant({ defects: { silentOnConnect: true } }, async (port) => {
    const result = await runCase(tc, {
      connect: { host: '127.0.0.1', port },
      fixture: richFixture,
      caseTimeoutMs: 8000,
    });
    assert.equal(
      result.outcome,
      'inconclusive',
      `a slow/silent-but-open server must be inconclusive, got ${result.outcome}`,
    );
  });
});
