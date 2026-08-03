/**
 * One updater run at a time. See run-lock.ts for what a second one costs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock, RunLockError } from './run-lock.ts';

function inTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'runlock-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a second run is refused while the first holds the lock, and allowed after it releases', () => {
  inTmp((dir) => {
    const first = acquireRunLock(dir);
    // A different pid, because the same one is the "this process again" case handled below.
    assert.throws(() => acquireRunLock(dir, process.pid + 1), RunLockError);
    // The refusal names the holder and says nothing was changed — an operator who runs `apply` by
    // hand during a timer tick needs to know it was declined, not wonder what it did.
    try {
      acquireRunLock(dir, process.pid + 1);
      assert.fail('should have thrown');
    } catch (e) {
      assert.match((e as Error).message, new RegExp(`pid ${process.pid}\\b`));
      assert.match((e as Error).message, /Nothing was changed/);
    }
    first.release();
    const second = acquireRunLock(dir, process.pid + 1);
    second.release();
  });
});

test('releasing twice is harmless, and leaves the store clean', () => {
  inTmp((dir) => {
    const lock = acquireRunLock(dir);
    assert.equal(existsSync(join(dir, 'run.lock')), true);
    lock.release();
    lock.release();
    assert.equal(existsSync(join(dir, 'run.lock')), false, 'the lock does not outlive the run');
  });
});

test('a lock left behind by a dead process is broken, not waited on forever', () => {
  // The failure this avoids is worse than a collision: a lock nobody can clear means the deployment
  // never updates again, which is the exact rot this whole subsystem exists to prevent. A machine
  // that loses power mid-run must come back able to work.
  inTmp((dir) => {
    mkdirSync(join(dir, 'run.lock'), { recursive: true });
    // A pid that cannot be running: the kernel would have to have wrapped all the way round, and
    // the check is `process.kill(pid, 0)` regardless, so this is a genuine "is it alive" test.
    writeFileSync(join(dir, 'run.lock', 'pid'), '999999999');
    const lock = acquireRunLock(dir);
    lock.release();
  });

  // A lock directory with no pid file at all — a run that died between mkdir and write — is also
  // stale rather than permanent.
  inTmp((dir) => {
    mkdirSync(join(dir, 'run.lock'), { recursive: true });
    const lock = acquireRunLock(dir);
    lock.release();
  });
});

test('a holder mid-write (empty pid now, live pid a moment later) is NOT stolen', () => {
  // The TOCTOU this closes: the claim is `mkdir` (ownership) then a separate write of the pid, so a
  // second process arriving in that gap sees the lock with an empty pid file. Reading it once and
  // concluding "died mid-write, steal it" is how two runs proceed at once — the exact double-run this
  // lock prevents (a hand-run apply reverting a timer's good cutover). The read must tolerate the
  // gap: an empty pid that becomes a LIVE pid is a live owner, and must block.
  inTmp((dir) => {
    // The owner has done its mkdir but not yet written its pid.
    mkdirSync(join(dir, 'run.lock'), { recursive: true });
    let reads = 0;
    // First read: empty (owner mid-write). Second read: the owner's (live) pid has landed.
    const readPid = (): string | null => (reads++ === 0 ? '' : String(process.pid));
    assert.throws(
      () => acquireRunLock(dir, process.pid + 1, { readPid, sleep: () => {} }),
      RunLockError,
      'a live owner revealed on re-read blocks; the lock is not stolen',
    );
    assert.ok(reads >= 2, 'the empty pid was re-read rather than trusted once');
  });
});

test('a pid empty across the whole retry window is a real crash-mid-write and is recovered', () => {
  // The other side of the same coin: if the pid never appears, the claimant genuinely died between
  // the mkdir and the write, and the lock must be broken rather than block forever (the "lock nobody
  // can clear" rot). Distinguishing this from the case above is the whole point of the bounded retry.
  inTmp((dir) => {
    mkdirSync(join(dir, 'run.lock'), { recursive: true });
    const lock = acquireRunLock(dir, process.pid + 1, { readPid: () => '', sleep: () => {} });
    lock.release();
  });
});

test('a live holder blocks even the process that took it', () => {
  // No "it is only me" carve-out. A run that can bypass its own lock is a run whose lock proves
  // nothing — and the carve-out is invisible in normal use, because nothing acquires twice, so it
  // would sit there being wrong until the day something did.
  inTmp((dir) => {
    const lock = acquireRunLock(dir);
    assert.throws(() => acquireRunLock(dir), RunLockError, 'the same process is refused too');
    assert.throws(() => acquireRunLock(dir, process.pid + 1), RunLockError);
    lock.release();
  });
});
