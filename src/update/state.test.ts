/**
 * The persisted cutover state.
 *
 * Two behaviours here are load-bearing and neither is obvious. A state file that will not parse is
 * an ERROR, not an empty state: the phase it held might have been `switching`, and assuming the
 * safe-looking answer is how a half-finished cutover becomes permanent. A file that is simply
 * absent is a first run, which is a different thing entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateFile, UpdateStateError, INITIAL_STATE, enterPhase, recordCheck, staleness } from './state.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DAY_MS = 86_400_000;

function inTmp(fn: (state: StateFile, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-state-'));
  try {
    fn(new StateFile(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a store that has never run reads as idle, and a round trip preserves everything', () => {
  inTmp((state, dir) => {
    assert.deepEqual(state.read(), INITIAL_STATE);

    const written = enterPhase(INITIAL_STATE, 'switching', 1000, {
      candidate: SHA_B,
      previous: SHA_A,
      snapshotDir: '/snap',
      schemaMovedForward: true,
    });
    state.write(written);
    assert.deepEqual(state.read(), written);

    // Atomic: the temporary file is renamed, never left beside the target.
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });
});

test('a state file that will not parse is refused, not silently reset', () => {
  inTmp((state) => {
    writeFileSync(state.path, '{ this is not json');
    assert.throws(() => state.read(), (e: Error) => {
      assert.ok(e instanceof UpdateStateError);
      // The reason matters: an operator has to know that a phase was lost, not just that a file is bad.
      assert.match(e.message, /Refusing to guess what this deployment was doing/);
      return true;
    });
  });
});

test('a state file with a field this build does not understand is refused', () => {
  inTmp((state) => {
    for (const [what, contents] of [
      ['a future version', '{"version":2,"phase":"idle"}'],
      ['an unknown phase', '{"version":1,"phase":"teleporting"}'],
      ['a candidate that is not a commit id', `{"version":1,"phase":"probing","candidate":"main"}`],
      ['a truncated commit id', `{"version":1,"phase":"probing","previous":"abc123"}`],
      ['a bare value', '"idle"'],
    ] as const) {
      writeFileSync(state.path, contents);
      assert.throws(() => state.read(), UpdateStateError, what);
    }
  });
});

test('check history is recorded and bounded', () => {
  inTmp((state) => {
    let s = INITIAL_STATE;
    for (let i = 0; i < 30; i++) s = recordCheck(s, 1000 + i, `check ${i}`, { reachedRemote: true, sha: SHA_A });
    assert.equal(s.history.length, 20, 'a run every six hours for years must not grow this file without bound');
    assert.equal(s.history[0]!.outcome, 'check 10', 'the newest are kept');
    assert.equal(s.history[19]!.outcome, 'check 29');
    state.write(s);
    assert.equal(state.read().history.length, 20);
  });
});

test('a check that never reached the remote does not count as a success', () => {
  let s = recordCheck(INITIAL_STATE, 1000, 'up-to-date', { reachedRemote: true });
  assert.equal(s.lastSuccessAt, 1000);
  s = recordCheck(s, 2000, 'network unreachable', { reachedRemote: false });
  assert.equal(s.lastCheckAt, 2000, 'the attempt is recorded');
  assert.equal(s.lastSuccessAt, 1000, 'but the staleness clock keeps running from the last real contact');
});

test('staleness is the mirror image of the bake rule', () => {
  const staleMs = 30 * DAY_MS;
  // Never checked: nothing to be stale about yet.
  assert.deepEqual(staleness(INITIAL_STATE, 1_000_000, staleMs), { ageMs: null, stale: false, reason: null });

  const healthy = recordCheck(INITIAL_STATE, 0, 'up-to-date', { reachedRemote: true });
  assert.equal(staleness(healthy, 29 * DAY_MS, staleMs).stale, false);

  // Anyone who can block access to the remote otherwise pins a deployment forever, silently.
  const blocked = staleness(healthy, 40 * DAY_MS, staleMs);
  assert.equal(blocked.stale, true);
  assert.match(blocked.reason!, /last successful update check was 40 day\(s\) ago/);
  assert.match(blocked.reason!, /quietly falling behind/);

  // Never succeeded at all: measured from the first attempt, so a broken configuration surfaces on
  // the same schedule instead of never.
  const brokenSinceStart = recordCheck(INITIAL_STATE, 0, 'no such branch', { reachedRemote: false });
  const never = staleness(brokenSinceStart, 40 * DAY_MS, staleMs);
  assert.equal(never.stale, true);
  assert.match(never.reason!, /has EVER reached the remote/);
  assert.match(never.reason!, /no such branch/);
});

test('update() reads, transforms and writes in one step', () => {
  inTmp((state) => {
    state.write(enterPhase(INITIAL_STATE, 'fetched', 10, { candidate: SHA_B }));
    const next = state.update((s) => enterPhase(s, 'verified', 20));
    assert.equal(next.phase, 'verified');
    assert.equal(next.candidate, SHA_B, 'the rest of the state carries forward');
    assert.equal(next.enteredAt, 20);
    assert.deepEqual(state.read(), next);
  });
});
