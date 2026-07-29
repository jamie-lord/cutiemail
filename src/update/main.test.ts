/**
 * The updater CLI: the commands an operator actually types, and the answers they get back.
 *
 * `check` and `apply` need a remote and a service, and are covered where they live (acquire,
 * preflight, cutover). What is tested here is everything around them — the refusals, the exit
 * codes, and the one report an operator is most likely to be reading at 2am because mail stopped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdate, systemdService, parseSystemdTimespan } from './main.ts';
import { acquireRunLock } from './run-lock.ts';
import { VersionStore } from './version-store.ts';
import { StateFile, INITIAL_STATE, enterPhase, recordCheck } from './state.ts';
import { UpdateConfigError } from './config.ts';

const SHA = 'a'.repeat(40);
const DAY_MS = 86_400_000;

function capture(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function inStore(fn: (root: string, env: Record<string, string | undefined>) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-update-cli-'));
  const env = { MAIL_UPDATE_ROOT: join(dir, 'store'), MAIL_CONTROL_DB: join(dir, 'control.db') };
  return Promise.resolve(fn(join(dir, 'store'), env)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A store with one adopted version, without going near the network. */
function seedStore(root: string): VersionStore {
  const store = new VersionStore(root);
  store.ensure();
  const staged = store.stagingPath(SHA);
  mkdirSync(join(staged, 'src'), { recursive: true });
  writeFileSync(join(staged, 'src', 'main.ts'), '//\n');
  store.promote(SHA);
  store.switchTo(SHA);
  return store;
}

test('no command prints usage and exits 2; an unknown one says which', async () => {
  const a = capture();
  assert.equal(await runUpdate([], a.io, {}), 2);
  assert.match(a.out.join('\n'), /usage: node src\/update\/main\.ts/);

  const b = capture();
  assert.equal(await runUpdate(['--help'], b.io, {}), 0, 'asking for help is not an error');

  const c = capture();
  assert.equal(await runUpdate(['upgrade'], c.io, {}), 2);
  assert.match(c.err.join('\n'), /unknown command: upgrade/);
});

test('a configuration error is reported before anything is attempted', async () => {
  const a = capture();
  assert.equal(await runUpdate(['check'], a.io, { MAIL_UPDATE_MODE: 'aply' }), 2);
  assert.match(a.err.join('\n'), /MAIL_UPDATE_MODE must be/);
});

test('a pinned deployment checks nothing and says so', async () => {
  await inStore(async (root, env) => {
    const a = capture();
    // The point of `off` is that it stops everything, including a hand-run apply.
    assert.equal(await runUpdate(['check'], a.io, { ...env, MAIL_UPDATE_MODE: 'off' }), 1);
    assert.match(a.err.join('\n'), /this deployment is pinned/);

    const b = capture();
    assert.equal(await runUpdate(['apply'], b.io, { ...env, MAIL_UPDATE_MODE: 'off' }), 1);

    // `auto` is what the timer runs, so it exits 0: a pinned deployment is not a failing one, and a
    // timer that reports failure every hour is a timer whose failures get ignored.
    const c = capture();
    assert.equal(await runUpdate(['auto'], c.io, { ...env, MAIL_UPDATE_MODE: 'off' }), 0);
    assert.match(c.out.join('\n'), /nothing to do/);
    assert.equal(root.length > 0, true);
  });
});

test('adopt refuses anything that is not a full commit id', async () => {
  await inStore(async (_root, env) => {
    const a = capture();
    assert.equal(await runUpdate(['adopt'], a.io, env), 2);
    assert.match(a.err.join('\n'), /git rev-parse HEAD/);

    for (const bad of ['abc1234', 'HEAD', 'main', 'A'.repeat(40)]) {
      const b = capture();
      assert.equal(await runUpdate(['adopt', bad], b.io, env), 2, bad);
      assert.match(b.err.join('\n'), /not a full 40-character lowercase commit id/);
    }
  });
});

test('adopting a DIFFERENT commit is refused: it would discard the ancestry every update is checked against', async () => {
  await inStore(async (root, env) => {
    seedStore(root);
    const a = capture();
    assert.equal(await runUpdate(['adopt', 'b'.repeat(40)], a.io, env), 1);
    assert.match(a.err.join('\n'), /already tracks/);
    assert.equal(new VersionStore(root).currentSha(), SHA, 'and what runs is unchanged');
  });
});

test('status on a store that does not exist points at the first step', async () => {
  await inStore(async (_root, env) => {
    const a = capture();
    assert.equal(await runUpdate(['status'], a.io, env), 0);
    assert.match(a.out.join('\n'), /does not exist yet: run `adopt <commit>`/);
  });
});

test('status reports what runs, and raises the alarm when checks stop getting through', async () => {
  await inStore(async (root, env) => {
    const store = seedStore(root);
    const state = new StateFile(store.root);

    state.write(recordCheck(INITIAL_STATE, Date.now(), 'up to date', { upToDate: true }));
    const healthy = capture();
    assert.equal(await runUpdate(['status'], healthy.io, env), 0);
    assert.match(healthy.out.join('\n'), new RegExp(`running:\\s+${SHA}`));
    assert.match(healthy.out.join('\n'), /phase:\s+idle/);
    assert.match(healthy.out.join('\n'), /staleness:\s+0\.0 day\(s\)/);

    // Anyone who can block access to the remote otherwise pins this deployment forever, silently.
    // This is the report that stops that being silent, so it exits non-zero and says what to check.
    state.write(recordCheck(INITIAL_STATE, Date.now() - 60 * DAY_MS, 'getaddrinfo ENOTFOUND', { upToDate: true }));
    const stale = capture();
    assert.equal(await runUpdate(['status'], stale.io, env), 1);
    assert.match(stale.err.join('\n'), /WARNING: this deployment was last up to date 60 day\(s\) ago/);
    assert.match(stale.err.join('\n'), /Updates are configured but not arriving/);
  });
});

test('status reports an unreadable state rather than pretending it is idle', async () => {
  await inStore(async (root, env) => {
    const store = seedStore(root);
    writeFileSync(new StateFile(store.root).path, 'not json at all');
    const a = capture();
    assert.equal(await runUpdate(['status'], a.io, env), 1);
    assert.match(a.err.join('\n'), /state:\s+UNREADABLE/);
  });
});

test('reset clears a stuck phase and changes nothing else', async () => {
  await inStore(async (root, env) => {
    const store = seedStore(root);
    const state = new StateFile(store.root);
    const snapshotDir = join(root, 'snapshots', 'pre');
    state.write(enterPhase(INITIAL_STATE, 'probing', 1, { candidate: 'b'.repeat(40), previous: SHA, snapshotDir }));

    const a = capture();
    assert.equal(await runUpdate(['reset'], a.io, env), 0);
    assert.match(a.out.join('\n'), /clearing a probing state/);
    // The situations that lead here are exactly the ones where an operator decides what runs.
    assert.match(a.out.join('\n'), /is NOT changed/);
    assert.match(a.out.join('\n'), new RegExp(`snapshot may still be at ${snapshotDir}`));
    assert.equal(store.currentSha(), SHA, 'the symlink is untouched');
    assert.equal(state.read().phase, 'idle');
    assert.equal(state.read().candidate, null);
  });
});

test('reset works on a state file that will not parse — which is what it is for', async () => {
  await inStore(async (root, env) => {
    const store = seedStore(root);
    writeFileSync(new StateFile(store.root).path, '{ truncated');
    const a = capture();
    assert.equal(await runUpdate(['reset'], a.io, env), 0);
    assert.equal(new StateFile(store.root).read().phase, 'idle');
  });
});

test('an implausible unit name is refused rather than handed to systemctl', () => {
  for (const bad of ['cutiemail; rm -rf /', 'unit name', '../../etc/passwd', '']) {
    assert.throws(() => systemdService(bad), UpdateConfigError, bad);
  }
  for (const ok of ['cutiemail.service', 'cutiemail@1.service', 'mail-server.service']) {
    assert.doesNotThrow(() => systemdService(ok), ok);
  }
});

test('a store-mutating command is refused while another run holds the lock', async () => {
  // The collision this prevents was observed live: a timer-driven cutover had switched and passed
  // its probe, a hand-run `apply` started during the watch window, and the deployment was rolled
  // back off a good version. Every run begins by recovering an interrupted cutover, and one process
  // cannot tell another's legitimate in-progress switch from a crashed one.
  await inStore(async (root, env) => {
    seedStore(root);
    const held = acquireRunLock(root); // a live holder — this process, which is unarguably alive
    try {
      for (const command of ['check', 'apply', 'auto', 'adopt', 'reset']) {
        const { io, err } = capture();
        const code = await runUpdate([command, SHA], io, { ...env, MAIL_UPDATE_MODE: 'check' });
        assert.equal(code, 1, `${command} is declined while another run holds the lock`);
        assert.match(err.join('\n'), /another update run is already working/, command);
        assert.match(err.join('\n'), /Nothing was changed/, command);
      }
      // `status` is read-only and must still work — an operator diagnosing a stuck run needs it.
      const { io, out } = capture();
      assert.equal(await runUpdate(['status'], io, { ...env, MAIL_UPDATE_MODE: 'check' }), 0);
      assert.match(out.join('\n'), /running:/, 'status is not serialised');
    } finally {
      held.release();
    }
  });
});

test('the unit start budget is read from the timespan systemd actually prints', () => {
  // `Number(out)` was the defect. systemd renders every *USec property through FORMAT_TIMESPAN
  // (src/shared/bus-print-properties.c), never as an integer, so the parse produced NaN on every
  // real deployment and the migration-versus-start-budget comparison ADR 0025 promises silently
  // never ran. There is no JSON output mode for `systemctl show` to switch to (systemd#39081).
  assert.equal(parseSystemdTimespan('1min 30s'), 90_000, "systemd's default 90s start timeout");
  assert.equal(parseSystemdTimespan('45min'), 2_700_000);
  assert.equal(parseSystemdTimespan('2s'), 2_000);
  assert.equal(parseSystemdTimespan('90s'), 90_000);
  assert.equal(parseSystemdTimespan('5min 20s'), 320_000);
  assert.equal(parseSystemdTimespan('1min 30s 500ms'), 90_500);

  // No budget to compare against → decline to judge, rather than invent one.
  assert.equal(parseSystemdTimespan('infinity'), undefined);
  assert.equal(parseSystemdTimespan(''), undefined);
  assert.equal(parseSystemdTimespan('0'), undefined);
  assert.equal(parseSystemdTimespan('garbage'), undefined);

  // The raw-integer form the old code assumed is NOT something systemd emits for this property;
  // accepting it anyway would resurrect the false-confidence path.
  assert.equal(parseSystemdTimespan('90000000'), undefined, 'a bare integer is not a timespan');
});
