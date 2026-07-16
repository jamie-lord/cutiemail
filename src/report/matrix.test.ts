import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix, renderMatrix } from './matrix.ts';
import type { ServerRun } from './matrix.ts';
import type { Result, Outcome } from '../conformance/outcome.ts';

function result(reqId: string, outcome: Outcome): Result {
  return {
    requirementId: reqId,
    testId: `test-${reqId}`,
    level: 'MUST',
    outcome,
    judgement: outcome === 'non-conformant' ? { kind: 'violated', detail: 'x' } : { kind: 'satisfied' },
    expected: 'x',
    evidence: { transcript: [], reply: null, anomalies: [] },
    elapsedMs: 1,
  };
}

function run(name: string, version: string | undefined, results: Result[]): ServerRun {
  return {
    meta: { serverName: name, serverVersion: version, runAt: '2026-07-15T22:00:00Z', suiteCommit: 'abc123' },
    results,
  };
}

test('a matrix aligns requirements across servers', () => {
  const m = buildMatrix([
    run('postfix', '3.8', [result('R-5321-2.3.8-a', 'conformant')]),
    run('exim', '4.97', [result('R-5321-2.3.8-a', 'conformant')]),
  ]);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0]!.cells.get('postfix')?.outcome, 'conformant');
  assert.equal(m.rows[0]!.cells.get('exim')?.outcome, 'conformant');
});

test('a substantive disagreement is flagged as a divergence', () => {
  const m = buildMatrix([
    run('good', '1', [result('R-5321-2.3.8-a', 'conformant')]),
    run('bad', '1', [result('R-5321-2.3.8-a', 'non-conformant')]),
  ]);
  assert.equal(m.divergences.length, 1);
  assert.equal(m.divergences[0]!.requirementId, 'R-5321-2.3.8-a');
});

test('inconclusive-vs-conformant is NOT a divergence', () => {
  // Usually means one run lacked a fixture. Folding it in would bury the real
  // disagreements under fixture noise.
  const m = buildMatrix([
    run('a', '1', [result('R-5321-2.3.8-a', 'conformant')]),
    run('b', '1', [result('R-5321-2.3.8-a', 'inconclusive')]),
  ]);
  assert.equal(m.divergences.length, 0);
});

test('permitted-latitude-vs-conformant IS a divergence', () => {
  // Both are non-failures, but one server declined a SHOULD the other honoured —
  // a real, reportable behavioural difference.
  const m = buildMatrix([
    run('a', '1', [result('R-5321-2.4-n', 'conformant')]),
    run('b', '1', [result('R-5321-2.4-n', 'permitted-latitude')]),
  ]);
  assert.equal(m.divergences.length, 1);
});

test('a requirement with multiple cases never masks a finding in the cell', () => {
  // R-5321-4.1.1.4-i really has three cases (the smuggling variants). A server
  // that passes two but fails one must show X for the requirement, not OK —
  // otherwise the matrix hides the finding it exists to surface.
  const m = buildMatrix([
    run('vulnerable', '1', [
      result('R-5321-4.1.1.4-i', 'conformant'), // rejects bare-LF
      result('R-5321-4.1.1.4-i', 'non-conformant'), // honours <LF>.<CR><LF> — the CVE
      result('R-5321-4.1.1.4-i', 'conformant'), // rejects <CR>.<CR>
    ]),
  ]);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0]!.cells.get('vulnerable')?.outcome, 'non-conformant');
  // and the winning cell points at the failing case, so it is findable
  assert.equal(m.rows[0]!.cells.get('vulnerable')?.testId, 'test-R-5321-4.1.1.4-i');
});

test('a masked finding still drives divergence detection', () => {
  // One server clean on all cases, the other clean on the first case but failing
  // a later one. Before the aggregation fix, the failing server\'s cell was the
  // first (conformant) result, so the divergence vanished.
  const m = buildMatrix([
    run('clean', '1', [
      result('R-5321-4.1.1.4-i', 'conformant'),
      result('R-5321-4.1.1.4-i', 'conformant'),
    ]),
    run('vulnerable', '1', [
      result('R-5321-4.1.1.4-i', 'conformant'),
      result('R-5321-4.1.1.4-i', 'non-conformant'),
    ]),
  ]);
  assert.equal(m.divergences.length, 1);
  assert.equal(m.divergences[0]!.cells.get('vulnerable')?.outcome, 'non-conformant');
});

test('a SHOULD with a declined case shows latitude over a passing case', () => {
  // permitted-latitude outranks conformant in a cell: "declined a SHOULD here" is
  // the more informative summary, and cannot co-occur with a MUST-level finding.
  const m = buildMatrix([
    run('s', '1', [
      result('R-5321-2.4-n', 'conformant'),
      result('R-5321-2.4-n', 'permitted-latitude'),
    ]),
  ]);
  assert.equal(m.rows[0]!.cells.get('s')?.outcome, 'permitted-latitude');
});

test('per-server summaries count outcomes', () => {
  const m = buildMatrix([
    run('s', '1', [
      result('r1', 'conformant'),
      result('r2', 'non-conformant'),
      result('r3', 'inconclusive'),
    ]),
  ]);
  const summary = m.perServerSummary.get('s')!;
  assert.equal(summary.conformant, 1);
  assert.equal(summary['non-conformant'], 1);
  assert.equal(summary.inconclusive, 1);
});

test('the rendering always shows version and run date — the anti-staleness contract', () => {
  const text = renderMatrix(buildMatrix([run('postfix', '3.8.1', [result('r1', 'conformant')])]));
  assert.match(text, /version=3\.8\.1/);
  assert.match(text, /run=2026-07-15/);
});

test('a missing version renders as UNKNOWN, never blank', () => {
  const text = renderMatrix(buildMatrix([run('mystery', undefined, [result('r1', 'conformant')])]));
  assert.match(text, /version=UNKNOWN/);
});
