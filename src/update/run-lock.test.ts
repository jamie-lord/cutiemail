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
