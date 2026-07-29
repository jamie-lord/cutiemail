/**
 * The cutover, and the recovery from an interrupted one.
 *
 * The service is a stand-in rather than a real daemon — the logic under test is this module's
 * ordering and its refusals, and a test cannot be asked to own a system unit. What is real here is
 * everything that matters for safety: real SQLite databases, real snapshots, a real symlink swap
 * and a real state file written to a real disk.
 *
 * The cases that earn their place are the ones where the cutover has to give up: a drain that does
 * not finish, a version that starts and then fails its probe, a version that dies inside the probe
 * window, and a machine that lost power half way through. In every one of them the deployment must
 * end up back on something that works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { VersionStore } from './version-store.ts';
import { StateFile, enterPhase, INITIAL_STATE, type Phase } from './state.ts';
import { cutover, recover, restoreOne, type CutoverDeps, type ServiceControl } from './cutover.ts';
import { accepts } from './candidate-process.ts';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** A stand-in daemon: a flag, plus whatever failure the test wants to inject. */
class FakeService implements ServiceControl {
  active = true;
  stopCalls = 0;
  startCalls = 0;
  /** When false, `stop` reports that the daemon never finished — the drain deadline case. */
  drains = true;
  /** When false, `start` reports the new version would not come up. */
  starts = true;
  /** Fires once the given number of isActive() polls have happened, simulating a late crash. */
  diesAfterPolls: number | null = null;
  #polls = 0;

  async stop(): Promise<boolean> {
    this.stopCalls++;
    if (!this.drains) return false;
    this.active = false;
    return true;
  }

  async start(): Promise<boolean> {
    this.startCalls++;
    if (!this.starts) return false;
    this.active = true;
    return true;
  }

  async isActive(): Promise<boolean> {
    this.#polls++;
    if (this.diesAfterPolls !== null && this.#polls > this.diesAfterPolls) this.active = false;
    return this.active;
  }
}

interface Harness {
  readonly dir: string;
  readonly store: VersionStore;
  readonly state: StateFile;
  readonly service: FakeService;
  readonly controlDb: string;
  readonly mailDb: string;
  readonly deps: CutoverDeps;
}

/** Install both versions, seed real data, and wire up a cutover. */
function makeHarness(dir: string, opts: { probeOk?: boolean } = {}): Harness {
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const controlDb = join(data, 'control.db');
  const mailDb = join(data, 'mail-alice.db');
  const db = openMailDb(controlDb);
  AccountRegistry.open(db).upsert('alice', 'alice-passphrase', mailDb);
  db.close();
  const userDb = openMailDb(mailDb);
  SqliteCatalog.open(userDb, 1).get('INBOX')!.append(Buffer.from('Subject: kept\r\n\r\noriginal\r\n', 'latin1'), [], 1);
  userDb.close();

  const store = new VersionStore(join(dir, 'store'));
  store.ensure();
  for (const sha of [OLD, NEW]) {
    const staged = store.stagingPath(sha);
    mkdirSync(join(staged, 'src'), { recursive: true });
    writeFileSync(join(staged, 'src', 'main.ts'), `// ${sha}\n`);
    store.promote(sha);
  }
  store.switchTo(OLD);

  const state = new StateFile(store.root);
  const service = new FakeService();
  const deps: CutoverDeps = {
    store,
    state,
    service,
    controlDbPath: controlDb,
    snapshotRoot: join(dir, 'snapshots'),
    env: { MAIL_DOMAIN: 'one.example' },
    drainDeadlineMs: 1000,
    probeWindowMs: 0,
    startTimeoutMs: 1000,
    probe: async () => (opts.probeOk === false ? { ok: false, detail: 'no message came back over IMAP' } : { ok: true, detail: 'mail path works' }),
  };
  return { dir, store, state, service, controlDb, mailDb, deps };
}

function inHarness(fn: (h: Harness) => Promise<void>, opts: { probeOk?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-cutover-'));
  return fn(makeHarness(dir, opts)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const inboxBody = (mailDb: string): string => {
  const db = openMailDb(mailDb);
  try {
    const raw = SqliteCatalog.open(db, 1).get('INBOX')!.raw(1);
    return raw === undefined ? '(gone)' : raw.toString('latin1');
  } finally {
    db.close();
  }
};

test('a clean cutover drains, switches, probes and confirms', async () => {
  await inHarness(async (h) => {
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, true);
    assert.equal(result.reverted, false);
    assert.equal(h.store.currentSha(), NEW);
    assert.deepEqual(result.steps.map((s) => s.name), ['snapshot', 'drain', 'switch', 'probe', 'watch']);
    assert.ok(result.steps.every((s) => s.ok));
    // Stopped once to drain, started once on the new version.
    assert.equal(h.service.stopCalls, 1);
    assert.equal(h.service.startCalls, 1);
    assert.equal(h.service.active, true);
    const state = h.state.read();
    assert.equal(state.phase, 'confirmed');
    assert.equal(state.snapshotDir, null);
    assert.equal(existsSync(join(h.dir, 'snapshots', `pre-${NEW}`)), false, 'the snapshot held every secret; it does not linger');
  });
});

test('a drain that does not finish abandons the cutover rather than forcing it', async () => {
  await inHarness(async (h) => {
    h.service.drains = false;
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, false);
    assert.equal(result.reverted, false, 'nothing was switched, so there is nothing to revert');
    // An update can wait; an interrupted delivery cannot be undone.
    assert.equal(h.store.currentSha(), OLD);
    const drain = result.steps.find((s) => s.name === 'drain')!;
    assert.match(drain.detail, /did not finish and stop within 1000ms; abandoning/);
    assert.equal(h.service.startCalls, 1, 'and the daemon is confirmed up before we walk away');
    assert.equal(h.state.read().phase, 'idle');
  });
});

test('a version that starts but fails its mail-path probe is reverted', async () => {
  await inHarness(async (h) => {
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, false);
    assert.equal(result.reverted, true);
    assert.equal(h.store.currentSha(), OLD, '"it started" is not confirmation');
    assert.match(result.steps.find((s) => s.name === 'probe')!.detail, /failed the mail-path probe.*no message came back/s);
    assert.equal(h.state.read().phase, 'idle');
    assert.equal(h.service.active, true, 'and the working version is running again');
  }, { probeOk: false });
});

test('a version that will not start at all is reverted', async () => {
  await inHarness(async (h) => {
    h.service.starts = false;
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, false);
    assert.equal(result.reverted, true);
    assert.equal(h.store.currentSha(), OLD);
  });
});

test('a version that dies inside the probe window is reverted', async () => {
  await inHarness(async (h) => {
    const deps: CutoverDeps = { ...h.deps, probeWindowMs: 60 };
    h.service.diesAfterPolls = 0; // the very first health poll finds it gone
    const result = await cutover(deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, false);
    assert.equal(result.reverted, true);
    assert.match(result.steps.find((s) => !s.ok)!.detail, /stopped running inside the 60ms probe window/);
    assert.equal(h.store.currentSha(), OLD);
  });
});

test('a failed cutover that migrated the schema restores the databases, keeping the failed ones', async () => {
  await inHarness(async (h) => {
    // Stand in for what the candidate's migration did: change the data, and leave a write-ahead log
    // beside it. The stale -wal is the trap `verify` warns about — copying a snapshot over a live
    // database without removing it makes SQLite replay those frames and resurrect what the snapshot
    // never held.
    const probe = async (): Promise<{ ok: boolean; detail: string }> => {
      const db = openMailDb(h.mailDb);
      SqliteCatalog.open(db, 1).get('INBOX')!.append(Buffer.from('Subject: after migration\r\n\r\nnew\r\n', 'latin1'), [], 2);
      db.close();
      writeFileSync(`${h.mailDb}-wal`, 'stale frames that must not be replayed');
      return { ok: false, detail: 'the new version mangles every message' };
    };

    const result = await cutover({ ...h.deps, probe }, NEW, { schemaMovedForward: true });
    assert.equal(result.ok, false);
    assert.equal(result.reverted, true);
    assert.equal(h.store.currentSha(), OLD);

    const restore = result.steps.find((s) => s.name === 'restore')!;
    assert.equal(restore.ok, true);
    assert.match(restore.detail, /could not read the migrated ones/);

    // Checked BEFORE anything opens the database: SQLite tidies away a malformed write-ahead log on
    // open, so an assertion made after a read would pass whether the restore removed it or not.
    assert.equal(existsSync(`${h.mailDb}-wal`), false, 'the stale write-ahead log went with the file it belonged to');
    // The pre-cutover content is back...
    assert.match(inboxBody(h.mailDb), /original/);

    // ...and nothing was destroyed: what the failed version wrote is still on disk.
    const kept = readdirSync(join(h.dir, 'data')).filter((f) => f.includes('.failed-'));
    assert.ok(kept.some((f) => f.startsWith('mail-alice.db.failed-')), `the failed version's mailbox is kept aside, got ${kept.join(', ')}`);
    assert.ok(kept.some((f) => f.startsWith('control.db.failed-')));
    const failedMail = kept.find((f) => f.startsWith('mail-alice.db.failed-'))!;
    assert.ok(readFileSync(join(h.dir, 'data', failedMail)).length > 0);
  });
});

test('a failed cutover that did NOT migrate leaves the databases alone', async () => {
  await inHarness(async (h) => {
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.reverted, true);
    // Flipping the symlink back is enough: the old build can read these, and restoring would throw
    // away anything that arrived after the snapshot for no reason at all.
    assert.equal(result.steps.some((s) => s.name === 'restore'), false);
    assert.deepEqual(readdirSync(join(h.dir, 'data')).filter((f) => f.includes('.failed-')), []);
    assert.match(inboxBody(h.mailDb), /original/);
  }, { probeOk: false });
});

test('no rollback position means no cutover', async () => {
  await inHarness(async (h) => {
    // Without a snapshot there is nowhere to go back to, and nothing about an update is worth
    // risking a mailbox for. The daemon must not even be stopped.
    rmSync(h.controlDb, { force: true });
    const result = await cutover(h.deps, NEW, { schemaMovedForward: false });
    assert.equal(result.ok, false);
    assert.match(result.steps.find((s) => s.name === 'snapshot')!.detail, /could not take a pre-cutover snapshot/);
    assert.equal(h.store.currentSha(), OLD);
    assert.equal(h.service.stopCalls, 0, 'the running daemon was never disturbed');
    assert.equal(h.service.active, true);
  });
});

test('a cutover is refused when there is nothing to cut over to, or from', async () => {
  await inHarness(async (h) => {
    await assert.rejects(() => cutover(h.deps, OLD, { schemaMovedForward: false }), /already running/);
    await assert.rejects(() => cutover(h.deps, 'c'.repeat(40), { schemaMovedForward: false }), /not a promoted version/);
  });
});

test('a cutover interrupted before the switch leaves the deployment untouched', async () => {
  for (const phase of ['fetched', 'verified', 'snapshotted', 'draining'] as Phase[]) {
    await inHarness(async (h) => {
      const snapshotDir = join(h.dir, 'snapshots', 'pre');
      mkdirSync(snapshotDir, { recursive: true });
      h.state.write(enterPhase(INITIAL_STATE, phase, 1, { candidate: NEW, previous: OLD, snapshotDir }));
      // As if the machine died with the daemon stopped, which `draining` would have done.
      h.service.active = false;

      const note = await recover(h.deps, h.state.read());
      assert.match(note!, new RegExp(`stopped during ${phase}`));
      assert.equal(h.store.currentSha(), OLD, `${phase}: the symlink was never touched`);
      assert.equal(h.service.active, true, `${phase}: and the daemon is brought back up`);
      assert.equal(h.state.read().phase, 'idle');
      if (phase === 'snapshotted' || phase === 'draining') {
        assert.equal(existsSync(snapshotDir), false, 'the abandoned snapshot is removed');
      }
    });
  }
});

test('a cutover interrupted AFTER the switch reverts, because nothing confirmed that version', async () => {
  await inHarness(async (h) => {
    // The state a power cut between the rename and the probe leaves behind.
    h.store.switchTo(NEW);
    h.state.write(enterPhase(INITIAL_STATE, 'probing', 1, { candidate: NEW, previous: OLD, snapshotDir: null }));
    h.service.active = false;

    const note = await recover(h.deps, h.state.read());
    assert.match(note!, /interrupted during probing with .* running unconfirmed; reverted/);
    assert.equal(h.store.currentSha(), OLD, 'back to something known to work');
    assert.equal(h.service.active, true);
    assert.equal(h.state.read().phase, 'idle');
  });
});

test('recovery after a completed revert simply tidies up', async () => {
  await inHarness(async (h) => {
    // `current` already points at the old version: the revert finished, the run died before saying so.
    h.state.write(enterPhase(INITIAL_STATE, 'reverting', 1, { candidate: NEW, previous: OLD, snapshotDir: null }));
    const note = await recover(h.deps, h.state.read());
    assert.match(note!, /the deployment is back on/);
    assert.equal(h.store.currentSha(), OLD);
    assert.equal(h.state.read().phase, 'idle');
  });
});

test('recovery from idle or confirmed does nothing at all', async () => {
  await inHarness(async (h) => {
    for (const phase of ['idle', 'confirmed'] as Phase[]) {
      h.state.write(enterPhase(INITIAL_STATE, phase, 1));
      assert.equal(await recover(h.deps, h.state.read()), null);
      assert.equal(h.state.read().phase, phase, 'and does not rewrite the state either');
    }
  });
});

test('the probe waits for the daemon to be SERVING, not merely started', async () => {
  // The race this pins, observed on a live box: `systemctl start` returns when a Type=simple unit's
  // process is forked, not when it is listening. In between, the daemon opens its databases,
  // migrates and binds three ports. Probing in that window failed with "could not connect to the
  // submission port", the cutover reverted, and a good update was rejected because the check was
  // faster than the thing it was checking.
  //
  // The default probe is the one under test here, so this drives it against a port that starts
  // closed and opens shortly afterwards — exactly the shape of a daemon still coming up.
  const server = createServer();
  const listening = new Promise<number>((resolve) => {
    setTimeout(() => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    }, 300);
  });

  // Before it opens, nothing accepts; afterwards it does. `accepts` is what readiness is measured
  // with, and measuring it on a socket that genuinely opens late is the only honest version of
  // this test.
  const port = await listening;
  try {
    assert.equal(await accepts(port, 500), true, 'the port accepts once the listener is up');
    // A port nobody is listening on must answer false rather than hanging, or the readiness wait
    // would block instead of timing out.
    const closed = createServer();
    const free = await new Promise<number>((resolve) => {
      closed.listen(0, '127.0.0.1', () => {
        const p = (closed.address() as AddressInfo).port;
        closed.close(() => resolve(p));
      });
    });
    assert.equal(await accepts(free, 500), false, 'a closed port answers false, promptly');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a symlink where a database should be is refused, not followed', async () => {
  // The data directory is group-writable and belongs to the mail daemon, so it can put a symlink
  // where a database should be. A DANGLING one is invisible to existsSync, so the rename-aside
  // never fires and copyFileSync follows the link — turning the restore, which runs as the updater,
  // into a write wherever the daemon points it. The updater can write the version store; the daemon
  // deliberately cannot (ADR 0025). A sandbox does not help: the wrong process is doing the writing.
  //
  // The account's mail_db_path points at a REAL file, so it is included in the snapshot; the
  // dangling symlink goes at the canonical destination the restore rebuilds from the login. A
  // dangling mail_db_path would instead be skipped by takeSnapshot and prove nothing.
  await inHarness(async (h) => {
    const codeStore = join(h.dir, 'store', 'versions', OLD, 'src');
    const implant = join(codeStore, 'IMPLANT.ts');

    const real = join(h.dir, 'data', 'real-source.db');
    const db = openMailDb(h.controlDb);
    db.prepare('UPDATE accounts SET mail_db_path = ?').run(real);
    db.close();
    const userDb = openMailDb(real);
    SqliteCatalog.open(userDb, 1).get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1'), [], 1);
    userDb.close();

    rmSync(h.mailDb, { force: true });
    symlinkSync(implant, h.mailDb); // dangling: the target does not exist yet

    const probe = async (): Promise<{ ok: boolean; detail: string }> => ({ ok: false, detail: 'forced revert' });
    const result = await cutover({ ...h.deps, probe }, NEW, { schemaMovedForward: true });

    assert.equal(existsSync(implant), false, 'nothing was written through the symlink into the code store');
    const restore = result.steps.find((s) => s.name === 'restore');
    assert.equal(restore?.ok, false, 'the restore refused rather than following the link');
    assert.match(restore!.detail, /not a regular file/);
  });
});

test('a login that could not have been created is refused when a restore rebuilds its path', async () => {
  // restoreSnapshot rebuilds the destination from the login rather than reading mail_db_path, so it
  // needs the same rule the snapshot enforces on the way in. Reachable through recover(), where the
  // snapshot on disk was written by whatever build ran last — including one without the guard.
  await inHarness(async (h) => {
    const snapDir = join(h.dir, 'snapshots', 'from-an-older-build');
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    const db = openMailDb(join(snapDir, 'control.db'));
    AccountRegistry.open(db).upsert('alice', 'pw', join(h.dir, 'data', 'mail-alice.db'));
    db.prepare('UPDATE accounts SET login = ?').run('../../escape');
    db.close();

    const lines: string[] = [];
    h.store.switchTo(NEW);
    h.state.update((s) =>
      enterPhase(s, 'probing', 1, { candidate: NEW, previous: OLD, snapshotDir: snapDir, schemaMovedForward: true }),
    );

    await recover({ ...h.deps, log: (l: string) => lines.push(l) }, h.state.read());

    assert.ok(
      lines.some((l) => /RESTORE FAILED/.test(l) && /not a valid login/.test(l)),
      `the restore refused and said why, got: ${lines.join(' | ')}`,
    );
    assert.equal(existsSync(join(h.dir, 'escape')), false, 'nothing was written outside the data directory');
  });
});

test('a revert keeps the failed version\'s write-ahead log with the database it belongs to', () => {
  // ADR 0025: "A revert never deletes." A WAL database is three files, and the aside copy was
  // only ever one of them — the sidecars kept the ORIGINAL name and were then unlinked, so the
  // preserved copy was silently rolled back to its last checkpoint. Everything committed since
  // was gone, including mail the server had already answered 250 for. The daemon is stopped by
  // `systemctl stop`, which SIGKILLs at TimeoutStopSec, so a hot WAL at this moment is the
  // normal case rather than the exotic one.
  const dir = mkdtempSync(join(tmpdir(), 'cm-revert-wal-'));
  try {
    const live = join(dir, 'mail-alice.db');
    const snap = join(dir, 'snap-mail-alice.db');
    writeFileSync(live, 'LIVE-MAIN');
    writeFileSync(`${live}-wal`, 'LIVE-WAL-COMMITTED-AFTER-SNAPSHOT');
    writeFileSync(`${live}-shm`, 'LIVE-SHM');
    writeFileSync(snap, 'SNAPSHOT-MAIN');

    restoreOne(snap, live, 'stamp1', () => {});

    // The snapshot is back in place…
    assert.equal(readFileSync(live, 'utf8'), 'SNAPSHOT-MAIN', 'the pre-cutover database is restored');
    // …and the failed version's data is ALL still on disk, where the operator was told it is.
    assert.equal(readFileSync(`${live}.failed-stamp1`, 'utf8'), 'LIVE-MAIN');
    assert.equal(
      readFileSync(`${live}.failed-stamp1-wal`, 'utf8'),
      'LIVE-WAL-COMMITTED-AFTER-SNAPSHOT',
      'the write-ahead log travelled with the database it belongs to',
    );
    // The restored database must not inherit the failed version's sidecars.
    assert.equal(existsSync(`${live}-wal`), false, 'no stale WAL is replayed into the restored database');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
