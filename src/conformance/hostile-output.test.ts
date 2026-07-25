/**
 * Remote-derived text must never reach the operator's terminal unsanitised.
 *
 * The conformance suite is pointed at somebody else's mail server — that is its whole purpose —
 * so the server under test is an untrusted party and the operator's terminal is the target. A
 * reply's text is retained verbatim by the framer (ESC is recorded as an anomaly, not stripped),
 * and several corpus cases quote a short prefix of it into a judgement's `detail`, which
 * `explain()` prints for every finding.
 *
 * Three attacker-controlled bytes are enough: ESC `]` opens an OSC sequence, and with no
 * terminator a terminal consumes everything after it — which means a hostile target can make the
 * suite visually suppress the very MUST violations it just found about that target. `explain()`
 * is also the natural chokepoint: sanitising inside it covers every corpus case, including ones
 * not yet written.
 *
 * Run-2 fixed exactly this class in the `mail` CLI, producing `sanitizeForTerminal`; these tests
 * pin the two places it was never applied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explain } from './outcome.ts';
import type { Result } from './outcome.ts';

/** Every byte a terminal treats as an escape introducer, per src/ops/terminal.ts. */
const hasTerminalControl = (s: string): boolean => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(s);

const RESULT = (judgement: Result['judgement'], outcome: Result['outcome']): Result => ({
  testId: 'hostile',
  requirementId: 'R-5321-4.2-a',
  level: 'MUST',
  outcome,
  judgement,
  expected: 'exactly one reply',
  evidence: { anomalies: [], reply: null, transcript: [] },
  elapsedMs: 1,
});

test('explain() strips terminal control sequences from every judgement branch', () => {
  // The real carrier: corpus cases quote `quiet.bytes.subarray(0,3)` of the remote reply.
  const osc = '\x1b]0'; // OSC introducer, deliberately unterminated
  const csi = '\x1b[2K\x1b[1A'; // erase line, cursor up — display forgery

  const violated = explain(RESULT({ kind: 'violated', detail: `a second: ${osc}${csi}` }, 'non-conformant'));
  assert.ok(!hasTerminalControl(violated), 'a violated detail must not carry escapes to the terminal');
  assert.match(violated, /a second: /, 'and the surrounding prose survives');

  const observed = explain(RESULT({ kind: 'observed', branch: `took ${osc}` }, 'permitted-latitude'));
  assert.ok(!hasTerminalControl(observed), 'an observed branch must be sanitised too');

  const inconclusive = explain(RESULT({ kind: 'inconclusive', reason: `greeting: ${osc}` }, 'inconclusive'));
  assert.ok(!hasTerminalControl(inconclusive), 'an inconclusive reason must be sanitised too');

  const satisfied = explain(RESULT({ kind: 'satisfied', detail: `identifies: ${osc}` }, 'conformant'));
  assert.ok(!hasTerminalControl(satisfied), 'a satisfied detail must be sanitised too');
});

test('explain() sanitises the anomaly join and leaves ordinary output byte-identical', () => {
  const withAnomalies = explain({
    ...RESULT({ kind: 'violated', detail: 'plain' }, 'non-conformant'),
    evidence: { anomalies: ['non-ascii-in-text@line1: \x1b]0', 'bare-lf@line2'], reply: null, transcript: [] },
  });
  assert.ok(!hasTerminalControl(withAnomalies), 'anomaly strings carry remote bytes too');

  // A clean result must be untouched — the sanitiser must not corrupt normal reports.
  const clean = explain(RESULT({ kind: 'violated', detail: 'NOOP drew more than one reply' }, 'non-conformant'));
  assert.match(clean, /observed: NOOP drew more than one reply/);
});
