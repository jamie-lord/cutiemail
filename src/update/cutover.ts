/**
 * The cutover: drained, reversible, and crash-safe (ADR 0025).
 *
 * By the time anything here runs, the candidate has climbed the whole verification ladder against a
 * copy of the real data. What is left is the part that touches the running service, and the design
 * rule for all of it is that **refusing is always correct**: the version currently running already
 * works, so every uncertainty resolves towards leaving it alone.
 *
 * The sequence, each step recorded before it is attempted:
 *
 *   1  snapshot     a consistent copy of every database, so a rollback has somewhere to go back to
 *   2  drain        ask the daemon to stop and WAIT for it to finish what it is doing
 *   3  switch       one rename over the `current` symlink
 *   4  start        bring the new version up
 *   5  probe        prove it live: all three ports, and a real message through the real mail path
 *   6  watch        stay watching for the probe window before calling it confirmed
 *
 * DRAIN MEANS DRAIN. Stopping the service is not a signal-and-hope: the daemon's SIGTERM handler
 * awaits `SmtpReceiver.close()`, which lets an in-flight DATA handler finish and reply against a
 * still-open database, and `relayLoop.stop()`, which waits for the current delivery tick. So "not
 * busy" has a real definition rather than a guess. If the daemon does not exit within the deadline,
 * the cutover is **abandoned rather than forced** — an update can wait; an interrupted delivery
 * cannot be undone.
 *
 * THE PROBE IS THE POINT. "It started" is not confirmation, and it is where most auto-updaters
 * stop. The probe sends a real message through authenticated submission on the real port, waits for
 * it to be delivered, reads it back over IMAP, and deletes it. Anything short of that would miss a
 * version that binds its ports and then fails on every message.
 *
 * The probe credential is minted immediately before and revoked immediately after, so there is no
 * standing password anywhere. That is not a new privilege for the updater — it already holds
 * database access in order to take snapshots at all — but a credential that exists for ninety
 * seconds is a smaller thing to lose than one that exists forever.
 *
 * ROLLBACK NEVER DELETES. When a revert has to restore the pre-cutover databases, the failed
 * version's databases are MOVED ASIDE rather than removed. Restoring costs whatever arrived in the
 * window between the snapshot and the failure — usually nothing, because the service is down for
 * most of it — and that is a real cost, so the thing that would have been lost is still on disk and
 * the operator is told exactly where.
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountRegistry, validLogin } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { runSelftest } from '../ops/selftest.ts';
import { takeSnapshot, type Snapshot } from './snapshot.ts';
import { accepts } from './candidate-process.ts';
import { StateFile, enterPhase, type UpdateState } from './state.ts';
import type { VersionStore } from './version-store.ts';

export class CutoverError extends Error {}

/**
 * Starting and stopping the running daemon.
 *
 * An interface rather than `systemctl` calls inline, because the cutover's logic is the part worth
 * testing and a test cannot be asked to own a system service. The systemd implementation lives in
 * the updater's entry point; everything here works against this shape.
 */
export interface ServiceControl {
  /** Ask the service to stop, and resolve true only once it HAS stopped, within the deadline. */
  stop(timeoutMs: number): Promise<boolean>;
  start(timeoutMs: number): Promise<boolean>;
  isActive(): Promise<boolean>;
}

export interface CutoverDeps {
  readonly store: VersionStore;
  readonly state: StateFile;
  readonly service: ServiceControl;
  /** The LIVE control database — the one the daemon uses. */
  readonly controlDbPath: string;
  /** Where pre-cutover snapshots are kept. */
  readonly snapshotRoot: string;
  readonly env: Record<string, string | undefined>;
  readonly drainDeadlineMs: number;
  readonly probeWindowMs: number;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Injected for tests; production uses the real end-to-end mail probe. */
  readonly probe?: (deps: CutoverDeps) => Promise<{ ok: boolean; detail: string }>;
}

export interface CutoverResult {
  readonly ok: boolean;
  /** What is running now. */
  readonly running: string | null;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail: string }>;
  readonly reverted: boolean;
}

const DEFAULT_START_TIMEOUT_MS = 120_000;
const PROBE_POLL_MS = 15_000;

/**
 * How long the daemon may take to go from started to listening after a cutover.
 *
 * Generous on purpose. The migration that runs in this window is the one rung 6a measured against a
 * snapshot, and the live databases will only be bigger; a bound that is merely "usually enough"
 * turns a slow migration into a spurious revert, which is the failure mode that teaches operators
 * to switch updates off.
 */
const READY_TIMEOUT_MS = 120_000;

/** Parse a positive-integer env var, mirroring main.ts so the probe dials the same ports. */
function posInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Send a real message through the running daemon and read it back.
 *
 * Against the REAL ports, over loopback: this is the only check that exercises the listeners
 * everyone else uses, with the real certificate and the real configuration. The credential exists
 * only for the duration.
 */
async function liveMailProbe(deps: CutoverDeps): Promise<{ ok: boolean; detail: string }> {
  // Wait for the daemon to be SERVING, not merely started.
  //
  // `systemctl start` returns when systemd considers the unit started, and for a Type=simple
  // service that is the moment the process is forked — not the moment it is listening. Between
  // those two the daemon opens its databases, applies any migration and binds three ports, which
  // on real data takes as long as rung 6a measured and reported. Probing in that window fails with
  // "could not connect to the submission port", the cutover reverts, and a perfectly good update is
  // rejected because the check was faster than the thing it was checking.
  //
  // Readiness is the ports accepting, for the same reason the pre-flight uses that and not a log
  // line: accepting a connection is a property of being a mail server, and a banner string is a
  // property of one implementation of one.
  const submission = posInt(deps.env.MAIL_SUBMISSION_PORT, 5587);
  const imap = posInt(deps.env.MAIL_IMAP_PORT, 5993);
  const readyBy = (deps.now ?? Date.now)() + READY_TIMEOUT_MS;
  for (;;) {
    const up = await Promise.all([accepts(submission, 1000), accepts(imap, 1000)]);
    if (up.every(Boolean)) break;
    // Patience is for a daemon that is still coming up, not for one that has gone. A version that
    // dies at boot — because it needs something the unit's sandbox forbids, say — would otherwise
    // hold the deployment down for the whole readiness budget before anyone reverted it. Asking
    // systemd whether the unit is still active turns that into a prompt, accurate failure.
    if (!(await deps.service.isActive())) {
      return { ok: false, detail: 'the new version exited during startup: the unit is no longer active' };
    }
    if ((deps.now ?? Date.now)() >= readyBy) {
      return {
        ok: false,
        detail:
          `the new version started but was not listening on ${submission}/${imap} within ${READY_TIMEOUT_MS}ms. ` +
          'That is a different failure from a broken mail path: the process is up and has not begun serving.',
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const db = openMailDb(deps.controlDbPath);
  let login: string;
  let password: string;
  const name = `updater-probe-${randomUUID().slice(0, 8)}`;
  try {
    const registry = AccountRegistry.open(db);
    const account = registry.list().find((a) => a.enabled);
    if (account === undefined) return { ok: false, detail: 'no enabled account to probe with' };
    login = account.login;
    password = registry.addAppPassword(login, name, (deps.now ?? Date.now)());
  } finally {
    db.close();
  }

  const lines: string[] = [];
  try {
    const code = await runSelftest(
      [login],
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      {
        MAIL_HOST: '127.0.0.1',
        MAIL_DOMAIN: deps.env.MAIL_DOMAIN ?? 'mail.example.com',
        MAIL_SUBMISSION_PORT: String(posInt(deps.env.MAIL_SUBMISSION_PORT, 5587)),
        MAIL_IMAP_PORT: String(posInt(deps.env.MAIL_IMAP_PORT, 5993)),
      },
      password,
    );
    return code === 0
      ? { ok: true, detail: `a message went out through submission, was delivered, and came back over IMAP as ${login}` }
      : { ok: false, detail: lines.join('\n') };
  } finally {
    // Revoked whatever happened, including when the probe threw: a credential that outlives its
    // purpose is exactly the kind of thing nobody remembers to clean up later.
    const cleanup = openMailDb(deps.controlDbPath);
    try {
      AccountRegistry.open(cleanup).removeAppPassword(login, name);
    } catch {
      // The database may be mid-restart. The credential is named so it can be found by hand.
    } finally {
      cleanup.close();
    }
  }
}

/** Every database file the daemon uses, live paths. */
function liveDatabases(controlDbPath: string): string[] {
  if (!existsSync(controlDbPath)) return [];
  const db = openMailDb(controlDbPath);
  try {
    const paths = AccountRegistry.open(db)
      .list()
      .map((a) => a.mailDbPath)
      .filter((p) => p !== ':memory:' && existsSync(p));
    return [controlDbPath, ...paths];
  } finally {
    db.close();
  }
}

/**
 * Put the pre-cutover databases back.
 *
 * Only reached when the candidate migrated a schema forward and then failed, because an older build
 * refuses to open a database from the future — flipping the symlink back without this would leave a
 * version that cannot start at all.
 *
 * The stale write-ahead log is the trap here, and it is the one `verify` warns about: copying a
 * snapshot over a live database while a `-wal` sidecar remains makes SQLite REPLAY those frames on
 * the next open, silently resurrecting state the snapshot never contained. The sidecars go first.
 */
function restoreSnapshot(snapshotDir: string, controlDbPath: string, log: (line: string) => void): void {
  const control = join(snapshotDir, 'control.db');
  if (!existsSync(control)) throw new CutoverError(`the pre-cutover snapshot at ${snapshotDir} has no control.db; refusing to restore from it`);

  // Read the account list from the SNAPSHOT: the live control database is about to be replaced, and
  // in a failed migration it may not be readable by this build at all.
  const snapshotDb = new DatabaseSync(control, { readOnly: true });
  let logins: string[];
  try {
    logins = (snapshotDb.prepare('SELECT login FROM accounts ORDER BY login').all() as Array<{ login: string }>).map((r) => r.login);
  } finally {
    snapshotDb.close();
  }

  const stamp = String(Date.now());
  const dir = dirname(controlDbPath);
  const restore = (from: string, to: string): void => {
    if (!existsSync(from)) return;
    // WHAT IS AT `to` IS NOT NECESSARILY A FILE WE WROTE. The data directory is group-writable and
    // belongs to the mail daemon, so it can put a symlink where a database should be — and a
    // DANGLING one is invisible to `existsSync`, so the rename-aside below never fires and the copy
    // follows the link instead. That turns this restore, which runs as the updater, into a write
    // wherever the daemon points it: the confused-deputy shape again, on the path that runs
    // precisely when something has already gone wrong. `lstat` does not follow, so it sees the link
    // itself.
    let target: ReturnType<typeof lstatSync> | null = null;
    try {
      target = lstatSync(to);
    } catch {
      target = null; // genuinely absent: a first restore of a database that never existed
    }
    if (target !== null && !target.isFile()) {
      throw new CutoverError(
        `refusing to restore over ${to}: it is not a regular file (${target.isSymbolicLink() ? 'symbolic link' : 'directory or special file'}). ` +
          'Something other than this program put it there.',
      );
    }
    if (target !== null) {
      // Moved aside, never deleted. Whatever arrived between the snapshot and the failure is in
      // here, and it is the operator's to keep or discard.
      renameSync(to, `${to}.failed-${stamp}`);
      log(`kept the failed version's ${to} as ${to}.failed-${stamp}`);
    }
    // The sidecars belong to the file being replaced. Left in place, SQLite replays them into the
    // restored database on the next open.
    for (const suffix of ['-wal', '-shm']) rmSync(to + suffix, { force: true });
    copyFileSync(from, to);
  };

  restore(control, controlDbPath);
  // The destination name is rebuilt from the login rather than read from the snapshot's
  // `mail_db_path`, so it must satisfy the same rule the snapshot enforced on the way in — a login
  // the account CLI could never have created has no business becoming a filename here either.
  for (const login of logins) {
    if (!validLogin(login)) {
      throw new CutoverError(
        `refusing to restore the database for login ${JSON.stringify(login)}: it is not a valid login, so it cannot be part of a filename.`,
      );
    }
    restore(join(snapshotDir, `mail-${login}.db`), join(dir, `mail-${login}.db`));
  }
  log(`restored ${logins.length + 1} database(s) from ${snapshotDir}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Move the running deployment to `candidate`.
 *
 * `candidate` must already be a promoted version in the store, and must have passed the pre-flight
 * ladder — this function does not re-verify it, and calling it on an unverified tree defeats the
 * entire design.
 */
export async function cutover(deps: CutoverDeps, candidate: string, opts: { readonly schemaMovedForward: boolean }): Promise<CutoverResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => {});
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
  const step = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  };

  const previous = deps.store.currentSha();
  if (previous === null) throw new CutoverError('the version store has no current version; adopt one before cutting over');
  if (previous === candidate) throw new CutoverError(`already running ${candidate}`);
  if (!deps.store.has(candidate)) throw new CutoverError(`${candidate} is not a promoted version in the store`);

  const finish = (ok: boolean, reverted: boolean): CutoverResult => ({ ok, running: deps.store.currentSha(), steps, reverted });

  // ---- 1. snapshot ---------------------------------------------------------------------------
  let snapshot: Snapshot;
  try {
    snapshot = takeSnapshot(deps.controlDbPath, join(deps.snapshotRoot, `pre-${candidate}`));
  } catch (e) {
    // No rollback position means no cutover. There is nothing here worth risking a mailbox for.
    step('snapshot', false, `could not take a pre-cutover snapshot: ${String(e)}`);
    return finish(false, false);
  }
  deps.state.update((s) =>
    enterPhase(s, 'snapshotted', now(), { candidate, previous, snapshotDir: snapshot.dir, schemaMovedForward: opts.schemaMovedForward }),
  );
  step('snapshot', true, `${snapshot.mailDbs.length + 1} database(s), ${snapshot.bytes} bytes, at ${snapshot.dir}`);

  // ---- 2. drain ------------------------------------------------------------------------------
  deps.state.update((s) => enterPhase(s, 'draining', now()));
  const drained = await deps.service.stop(deps.drainDeadlineMs);
  if (!drained) {
    // Abandon, do not force. The running version is still serving; a SIGKILL here could cut a
    // message part-way through DATA or a delivery part-way through a relay tick.
    step('drain', false, `the daemon did not finish and stop within ${deps.drainDeadlineMs}ms; abandoning the cutover and leaving ${previous} running`);
    snapshot.destroy();
    deps.state.update((s) => enterPhase(s, 'idle', now(), { candidate: null, snapshotDir: null }));
    // It was asked to stop and did not confirm; make sure it is up before walking away.
    await deps.service.start(deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    return finish(false, false);
  }
  step('drain', true, 'the daemon finished what it was doing and stopped');

  // ---- 3. switch -----------------------------------------------------------------------------
  deps.state.update((s) => enterPhase(s, 'switching', now()));
  deps.store.switchTo(candidate);
  step('switch', true, `current -> ${candidate}`);

  // ---- 4 & 5. start and probe ----------------------------------------------------------------
  deps.state.update((s) => enterPhase(s, 'probing', now()));
  const revert = async (why: string): Promise<CutoverResult> => {
    step('probe', false, why);
    deps.state.update((s) => enterPhase(s, 'reverting', now()));
    await revertTo(deps, previous, snapshot.dir, opts.schemaMovedForward, step);
    snapshot.destroy();
    deps.state.update((s) => enterPhase(s, 'idle', now(), { candidate: null, snapshotDir: null }));
    return finish(false, true);
  };

  if (!(await deps.service.start(deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS))) {
    return revert(`${candidate} did not start`);
  }
  const probe = deps.probe ?? liveMailProbe;
  const first = await probe(deps).catch((e: unknown) => ({ ok: false, detail: String(e) }));
  if (!first.ok) return revert(`the new version started but failed the mail-path probe: ${first.detail}`);
  step('probe', true, first.detail);

  // ---- 6. watch ------------------------------------------------------------------------------
  // "It started" is not confirmation. A version that crashes a minute in, or that binds its ports
  // and then fails on every message, is exactly what this window is for.
  const until = now() + deps.probeWindowMs;
  while (now() < until) {
    await delay(Math.min(PROBE_POLL_MS, Math.max(0, until - now())));
    if (!(await deps.service.isActive())) return revert(`${candidate} stopped running inside the ${deps.probeWindowMs}ms probe window`);
  }
  if (deps.probeWindowMs > 0) {
    const second = await probe(deps).catch((e: unknown) => ({ ok: false, detail: String(e) }));
    if (!second.ok) return revert(`the mail path stopped working inside the probe window: ${second.detail}`);
  }
  step('watch', true, `healthy for ${deps.probeWindowMs}ms after the switch`);

  snapshot.destroy();
  deps.state.update((s) => enterPhase(s, 'confirmed', now(), { candidate: null, previous: candidate, snapshotDir: null }));
  return finish(true, false);
}

/** Flip back, restoring the databases when the schema moved and the old build could not read them. */
async function revertTo(
  deps: CutoverDeps,
  previous: string,
  snapshotDir: string,
  schemaMovedForward: boolean,
  step: (name: string, ok: boolean, detail: string) => void,
): Promise<void> {
  const log = deps.log ?? ((): void => {});
  await deps.service.stop(deps.drainDeadlineMs);
  deps.store.switchTo(previous);
  if (schemaMovedForward) {
    try {
      restoreSnapshot(snapshotDir, deps.controlDbPath, log);
      step('restore', true, `the candidate migrated the schema forward, so the pre-cutover databases were put back (${previous} could not read the migrated ones)`);
    } catch (e) {
      // The worst place to be, and it must be loud rather than tidy.
      step('restore', false, `RESTORE FAILED: ${String(e)}. The snapshot is still at ${snapshotDir}; restore it by hand before starting the daemon.`);
      return;
    }
  }
  const started = await deps.service.start(deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  step('revert', started, started ? `back on ${previous}` : `flipped back to ${previous} but it did not start; the deployment needs attention`);
}

/**
 * What an interrupted run left behind, and what to do about it.
 *
 * Called before anything else, on every run. The phases that matter are the ones after the snapshot
 * was taken; anything earlier only ever touched the staging area, which is cleared regardless.
 */
export async function recover(deps: CutoverDeps, state: UpdateState): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => {});
  const toIdle = (): void => {
    deps.state.update((s) => enterPhase(s, 'idle', now(), { candidate: null, snapshotDir: null }));
  };

  if (state.phase === 'idle' || state.phase === 'confirmed') return null;

  const note = await recoverPhase(deps, state, log);
  toIdle();

  // ONE rule rather than one per branch: when recovery returns, the mail server is running. Which
  // phase was interrupted decides which VERSION runs; it should never decide whether anything runs
  // at all, and a recovery path that quietly leaves the service down is the worst possible outcome
  // of a mechanism whose whole purpose is availability.
  if (!(await deps.service.isActive())) {
    const started = await deps.service.start(deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    return `${note}${started ? ', and the daemon was restarted' : '. THE DAEMON WOULD NOT START: this deployment needs attention'}`;
  }
  return note;
}

/** The phase-specific half of recovery. Leaves the state alone; `recover` writes it. */
async function recoverPhase(deps: CutoverDeps, state: UpdateState, log: (line: string) => void): Promise<string> {
  switch (state.phase) {
    case 'fetched':
    case 'verified':
      // Nothing outside staging was touched, and staging is cleared at the start of every run.
      return `a previous run stopped during ${state.phase}; nothing had been changed`;

    case 'snapshotted':
    case 'draining':
      // The snapshot exists but the symlink was never touched, so the deployment is unchanged.
      if (state.snapshotDir !== null) rmSync(state.snapshotDir, { recursive: true, force: true });
      return `a previous run stopped during ${state.phase}; the running version was never changed`;

    case 'switching':
    case 'probing':
    case 'reverting': {
      // The decidable case. The swap is a single rename, so `current` points at exactly one of the
      // two versions and there is nothing in between to guess at.
      const running = deps.store.currentSha();
      const { candidate, previous, snapshotDir } = state;
      if (candidate === null || previous === null) {
        return `a previous run stopped during ${state.phase} without recording which versions were involved; left as it is`;
      }
      if (running === previous) {
        // Either the swap never happened or a revert completed.
        if (snapshotDir !== null) rmSync(snapshotDir, { recursive: true, force: true });
        return `a previous run stopped during ${state.phase}; the deployment is back on ${previous}`;
      }
      // We are on a version nobody confirmed. Reverting is the conservative move: it goes back to
      // something that was known to work, and the operator can retry the update deliberately.
      log(`recovering from an interrupted ${state.phase}: ${running ?? 'an unknown version'} was never confirmed, reverting to ${previous}`);
      await revertTo(deps, previous, snapshotDir ?? '', state.schemaMovedForward && snapshotDir !== null, (name, ok, detail) => {
        log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
      });
      if (snapshotDir !== null) rmSync(snapshotDir, { recursive: true, force: true });
      return `a previous run was interrupted during ${state.phase} with ${candidate} running unconfirmed; reverted to ${previous}`;
    }

    default:
      return `a previous run stopped during ${state.phase}`;
  }
}
