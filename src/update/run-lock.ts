/**
 * One updater run at a time, per version store.
 *
 * The timer alone is safe — systemd will not start a second instance of a unit that is already
 * running — so this exists for everything else: an operator running `check` or `apply` by hand
 * while the timer fires, a second timer left behind by a half-finished reconfiguration, a stuck run
 * someone decided to "help along". Every one of those puts two processes on the same version store.
 *
 * What that costs is not theoretical, and it is worse than losing the second run. Every run begins
 * by RECOVERING a cutover that was interrupted, because a machine that lost power mid-switch must
 * come back on something that works. To a process starting up, a cutover that another process is
 * legitimately part-way through is indistinguishable from one that died — so the newcomer reverts
 * it. Observed exactly that on a live box: a timer-driven cutover had switched and passed its probe,
 * a hand-run `apply` started during the watch window, and the deployment was rolled back off a good
 * version that had just proved itself.
 *
 * A directory is the lock, because `mkdir` is atomic on every POSIX filesystem and needs no
 * dependency. The holder's pid goes inside so a lock left by a killed process can be identified as
 * dead rather than waited on forever — the failure mode of a lock nobody can clear is a deployment
 * that never updates again, which is the thing this whole subsystem exists to prevent.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RunLockError extends Error {}

export interface RunLock {
  /** Release the lock. Safe to call twice. */
  release(): void;
}

/**
 * Seams for the test: the pid-file reader and the retry sleep. Production uses the real filesystem
 * and a synchronous sleep; a test injects a reader that reveals the pid appearing mid-write.
 */
export interface RunLockDeps {
  /** Read the holder pid file: its trimmed contents, or null if the file does not exist. */
  readonly readPid?: () => string | null;
  /** Sleep synchronously between retries. */
  readonly sleep?: (ms: number) => void;
}

/**
 * The claim races the write: `mkdir` establishes ownership, but the owner's pid lands a moment later
 * (a separate `writeFileSync`). A second process arriving in that window sees the lock but an empty
 * pid file, so it must NOT conclude "died mid-write, steal it" on the first read — that is exactly
 * how two runs proceed at once, the harm this lock exists to prevent. Re-read a few times first: a
 * live owner writes its pid within microseconds, so an owner mid-write is seen and blocked, while a
 * pid that stays empty across the whole window is a genuine crash between the mkdir and the write and
 * is recovered. The total budget is a thousandfold the real gap and is only ever paid on contention.
 */
const PID_READ_ATTEMPTS = 10;
const PID_READ_INTERVAL_MS = 10;

/** A synchronous sleep with no busy-wait or dependency, for the rare contended-recovery path. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is a process with this pid alive? Signal 0 tests for existence without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else — alive for our purposes.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the store's run lock, or throw explaining who holds it.
 *
 * A lock whose holder is gone is broken and retaken once. That is deliberately not a retry loop: if
 * the pid is alive the answer is "someone else is working", and waiting would just make two runs
 * overlap later instead of now.
 */
export function acquireRunLock(root: string, pid = process.pid, deps: RunLockDeps = {}): RunLock {
  const dir = join(root, 'run.lock');
  const pidfile = join(dir, 'pid');
  const readPid =
    deps.readPid ??
    ((): string | null => {
      try {
        return readFileSync(pidfile, 'utf8').trim();
      } catch (e) {
        // ENOENT: the lock was released between our EEXIST and this read — free to take. Any other
        // read error leaves the pid unknown (empty), which the caller retries.
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : '';
      }
    });
  const sleep = deps.sleep ?? sleepMs;
  // The holder's pid, tolerating the mkdir→write gap: null (gone) means free now; a non-empty value
  // is the holder; an empty value is retried, and only a value empty across the whole window means
  // the claimant crashed before writing its pid (→ 0, stale).
  const holderPid = (): number => {
    for (let attempt = 0; attempt < PID_READ_ATTEMPTS; attempt++) {
      const raw = readPid();
      if (raw === null) return 0;
      if (raw.length > 0) return Number(raw);
      if (attempt < PID_READ_ATTEMPTS - 1) sleep(PID_READ_INTERVAL_MS);
    }
    return 0;
  };
  const claim = (): void => {
    // The store root may not exist yet — `adopt` on a fresh deployment is the first thing that ever
    // runs, and it is one of the commands being serialised. Creating the root here is safe: the
    // store's own `ensure()` is idempotent and re-applies its permissions afterwards.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    writeFileSync(pidfile, String(pid), { mode: 0o600 });
  };
  try {
    claim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const holder = holderPid();
    // Any LIVE holder blocks, this process included. There is no "it is only me" carve-out: a run
    // that can bypass its own lock is a run whose lock proves nothing, and nothing here ever
    // acquires twice — `runUpdate` takes it once and releases it in a finally.
    if (holder > 0 && alive(holder)) {
      throw new RunLockError(
        `another update run is already working on ${root} (pid ${holder}). ` +
          'Nothing was changed. Updates are serialised because a second run would treat the first one\'s ' +
          'in-progress cutover as a crashed one and revert it.',
      );
    }
    rmSync(dir, { recursive: true, force: true });
    claim();
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
