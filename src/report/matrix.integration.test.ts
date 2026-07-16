/**
 * Differential-run integration: the matrix report's divergence detection,
 * exercised with REAL corpus results across multiple servers.
 *
 * The matrix's whole reason to exist is the differential view — where servers
 * disagree — and that path (task #24's machinery) is only unit-tested elsewhere.
 * Here we run the actual corpus against a clean mutant and two differently-broken
 * ones, build the matrix from the real results, and assert the divergences
 * surface at exactly the requirements the defects violate. This is the closest
 * thing to a real differential run against Postfix/Exim/Stalwart that this
 * environment can do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import type { Defects } from '../testing/mutant-server.ts';
import { ALL_CASES } from '../corpus/index.ts';
import { richFixture } from '../corpus/negative-control.ts';
import { buildMatrix } from './matrix.ts';
import type { ServerRun } from './matrix.ts';

async function runAgainst(name: string, defects: Defects): Promise<ServerRun> {
  return withMutant({ defects, validRecipients: ['recipient@example.com'], rejectedRecipients: ['nobody@example.com'] }, async (port) => {
    const results = await runSuite(ALL_CASES, {
      connect: { host: '127.0.0.1', port },
      fixture: richFixture,
      caseTimeoutMs: 8000,
    });
    return {
      meta: { serverName: name, serverVersion: 'mutant', runAt: '2026-07-16T00:00:00Z', suiteCommit: 'test' },
      results,
    };
  });
}

test('a clean server produces zero non-conformant results across the whole corpus', async () => {
  const run = await runAgainst('clean', {});
  const findings = run.results.filter((r) => r.outcome === 'non-conformant');
  assert.equal(
    findings.length,
    0,
    `clean server should produce no findings, got: ${findings.map((f) => `${f.requirementId}(${f.testId})`).join(', ')}`,
  );
});

test('the matrix surfaces a divergence where a broken server differs from a clean one', async () => {
  // honourBareLf makes the server EXECUTE a bare-LF command — a smuggling
  // violation the clean server does not have.
  const [clean, vuln] = await Promise.all([
    runAgainst('clean', {}),
    runAgainst('smuggling-vuln', { honourBareLf: true }),
  ]);
  const matrix = buildMatrix([clean, vuln]);

  assert.ok(matrix.divergences.length > 0, 'a broken server must diverge from the clean one');
  // The divergence must include the bare-LF requirement, and clean must be OK
  // there while the vulnerable server is non-conformant.
  const bareLfRow = matrix.divergences.find((r) => r.requirementId === 'R-5321-2.3.8-a');
  assert.ok(bareLfRow !== undefined, 'the bare-LF requirement should be a divergence');
  assert.equal(bareLfRow.cells.get('clean')?.outcome, 'conformant');
  assert.equal(bareLfRow.cells.get('smuggling-vuln')?.outcome, 'non-conformant');
});

test('two servers broken in DIFFERENT ways diverge at different requirements', async () => {
  const [a, b] = await Promise.all([
    runAgainst('no-help', { rejectHelp: true }),
    runAgainst('bad-codes', { fourDigitCode: true }),
  ]);
  const matrix = buildMatrix([a, b]);
  const divergentReqs = new Set(matrix.divergences.map((r) => r.requirementId));
  // no-help violates the HELP requirement; bad-codes violates the reply-code one.
  assert.ok(divergentReqs.has('R-5321-4.1.1.8-a'), 'HELP divergence expected from the no-help server');
  assert.ok(divergentReqs.has('R-5321-4.3.2-c'), 'reply-code divergence expected from the bad-codes server');
  // And each server is the non-conformant one at its OWN defect, not the other's.
  const help = matrix.divergences.find((r) => r.requirementId === 'R-5321-4.1.1.8-a');
  assert.equal(help?.cells.get('no-help')?.outcome, 'non-conformant');
  assert.equal(help?.cells.get('bad-codes')?.outcome, 'conformant');
});
