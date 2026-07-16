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

// A server answering 4yz under transient conditions (greylisting, load, disk
// pressure, shutdown) is fully CONFORMANT — a 4yz is never a MUST violation. So
// it must draw zero findings, exactly like the clean server. This invariant
// guards the whole class of "a MUST test forgot to give 4yz its latitude" false
// positive (the accepted-transaction-stored bug the negative-control harness,
// which only drives 250/5yz paths, could not catch). Each deferral stage is a
// distinct conformant profile; none may convict.
for (const [profile, defects] of [
  ['defers-at-mail', { tempDeferAtMail: true }],
  ['defers-at-rcpt', { tempDeferAtRcpt: true }],
  ['defers-at-storage', { tempDeferAtStorage: true }],
] as const) {
  test(`a temporarily-deferring server (${profile}) produces zero non-conformant results`, async () => {
    const run = await runAgainst(profile, defects);
    const findings = run.results.filter((r) => r.outcome === 'non-conformant');
    assert.equal(
      findings.length,
      0,
      `a conformant ${profile} server must produce no findings (a 4yz is never a violation), got: ${findings
        .map((f) => `${f.requirementId}(${f.testId})`)
        .join(', ')}`,
    );
  });
}

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
  // NB: uses unrecognizedNoop (a genuine §4.5.1-b MUST violation), NOT rejectHelp —
  // HELP support is a SHOULD, so a HELP refusal is permitted-latitude, never a
  // divergence (see help-supported in latitude.ts).
  const [a, b] = await Promise.all([
    runAgainst('no-noop', { unrecognizedNoop: true }),
    runAgainst('bad-codes', { fourDigitCode: true }),
  ]);
  const matrix = buildMatrix([a, b]);
  const divergentReqs = new Set(matrix.divergences.map((r) => r.requirementId));
  // no-noop violates the mandatory-command requirement; bad-codes the reply-code one.
  assert.ok(divergentReqs.has('R-5321-4.5.1-b'), 'NOOP divergence expected from the no-noop server');
  assert.ok(divergentReqs.has('R-5321-4.3.2-c'), 'reply-code divergence expected from the bad-codes server');
  // And each server is the non-conformant one at its OWN defect, not the other's.
  const noop = matrix.divergences.find((r) => r.requirementId === 'R-5321-4.5.1-b');
  assert.equal(noop?.cells.get('no-noop')?.outcome, 'non-conformant');
  assert.equal(noop?.cells.get('bad-codes')?.outcome, 'conformant');
});
