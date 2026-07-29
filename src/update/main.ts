/**
 * The updater's entry point — a SEPARATE program from the mail daemon (ADR 0025).
 *
 *   node src/update/main.ts status        what is running, and is it being kept up to date?
 *   node src/update/main.ts adopt <sha>   record what this deployment is running (once, first)
 *   node src/update/main.ts check         fetch, verify, report — never switch
 *   node src/update/main.ts apply         check, and if every rung passes, cut over
 *   node src/update/main.ts auto          what the timer runs: check or apply, per MAIL_UPDATE_MODE
 *   node src/update/main.ts reset         clear a stuck state after an operator has looked at it
 *
 * Why not a subcommand of `node src/main.ts`, like every other operator tool: because the daemon
 * must never be able to write its own code. It is the internet-facing, attack-surface-rich part, and
 * if a remote compromise of it could rewrite the version store then that compromise becomes
 * PERSISTENT — the attacker writes the next version. The systemd unit is deliberately sandboxed and
 * read-only outside the data directory; a self-rewriting daemon throws that away. So this is its own
 * entry point, run by its own unit, as its own user, with write access to the version store and no
 * ability to serve mail.
 *
 * Exit codes follow the other CLIs here: 0 success, 1 something failed or was refused, 2 usage or
 * configuration error.
 */

import { execFileSync } from 'node:child_process';
import { argv, stdout, stderr, env as processEnv } from 'node:process';
import { invokedDirectly } from '../entry-point.ts';
import { acquireRunLock, RunLockError, type RunLock } from './run-lock.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeForTerminalLine } from '../ops/terminal.ts';
import { updateConfigFromEnv, UpdateConfigError, type UpdateConfig } from './config.ts';
import { VersionStore, isCommitSha } from './version-store.ts';
import { GitRemote } from './smart-http.ts';
import { acquireCandidate, adoptVersion, type AcquireDeps } from './acquire.ts';
import { runPreflight, renderPreflight } from './preflight.ts';
import { cutover, recover, type CutoverDeps, type ServiceControl } from './cutover.ts';
import { runCommand } from './candidate-process.ts';
import { StateFile, INITIAL_STATE, enterPhase, recordCheck, staleness } from './state.ts';

export interface UpdateIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'usage: node src/update/main.ts <command>',
  '',
  'Keeps this deployment up to date with the repository it was installed from.',
  '',
  '  status        what is running, what the last check found, and whether checks are getting through',
  '  adopt <sha>   record the commit this deployment is running (needed once, before anything else)',
  '  check         fetch and verify the next version, report, and change nothing',
  '  apply         check, and cut over if every rung of the verification ladder passes',
  '  auto          what the timer runs: check or apply, whichever MAIL_UPDATE_MODE says',
  '  reset         clear a stuck cutover state, after looking at what it was',
  '',
  'Configured by MAIL_UPDATE_MODE (off/check/apply), MAIL_UPDATE_REPO, MAIL_UPDATE_BRANCH,',
  'MAIL_UPDATE_ROOT, MAIL_UPDATE_BAKE_DAYS, MAIL_UPDATE_STALE_DAYS, MAIL_UPDATE_KEEP,',
  'MAIL_UPDATE_UNIT, MAIL_UPDATE_DRAIN_SECONDS, MAIL_UPDATE_PROBE_SECONDS,',
  'MAIL_UPDATE_MAX_DEPTH, MAIL_UPDATE_ALLOW_IRREVERSIBLE, and the daemon\'s own MAIL_* variables.',
  'docs/SELF-UPDATE.md explains what each one trades away.',
].join('\n');

/**
 * Drive the daemon through systemd.
 *
 * `systemctl stop` already blocks until the unit has actually stopped, which is what makes the drain
 * a wait rather than a hope — the daemon's own SIGTERM handler finishes in-flight work first.
 * `is-active` is the truth afterwards, because a unit can fail to come up in ways that `start`
 * reports as success.
 */
/**
 * The service unit's own `TimeoutStartSec`, in milliseconds, as systemd will actually enforce it.
 *
 * Read from the unit rather than configured separately, because a second copy of a number that
 * already exists is a number that will disagree with it. The pre-flight uses this to say whether
 * the migration it just measured fits in the budget the real cutover will get — a migration killed
 * half-way through happens on the live databases.
 *
 * Anything unreadable (no systemd, a unit that does not exist, a value systemd reports as
 * "infinity") yields undefined, and the comparison is simply not made. Guessing a budget would be
 * worse than declining to judge.
 */
/**
 * Parse the timespan systemd actually prints, e.g. "1min 30s", "45min", "2s", "infinity".
 *
 * `Number(out)` was the bug, and a silent one. systemd special-cases every property whose name
 * contains `USec` and renders it through `FORMAT_TIMESPAN` rather than as an integer
 * (`src/shared/bus-print-properties.c`), so the parse produced `NaN` on every real deployment,
 * `unitStartTimeoutMs` always returned undefined, and the migration-versus-start-budget comparison
 * ADR 0025 promises simply never ran — with no warning, because the report just omits the clause.
 * `systemctl show` has no machine-readable output mode to switch to (systemd#39081), so the format
 * it does emit is the one to read.
 *
 * "infinity" is deliberately `undefined` rather than a huge number: there is no budget to compare
 * against, and declining to judge is the honest answer.
 */
export function parseSystemdTimespan(out: string): number | undefined {
  const t = out.trim();
  if (t === '' || t === 'infinity') return undefined;
  const UNITS: ReadonlyArray<readonly [string, number]> = [
    ['ms', 1],
    ['s', 1000],
    ['min', 60_000],
    ['h', 3_600_000],
    ['d', 86_400_000],
    ['w', 604_800_000],
    ['month', 2_629_800_000],
    ['y', 31_557_600_000],
  ];
  let total = 0;
  let sawOne = false;
  for (const m of t.matchAll(/(\d+)\s*(ms|min|month|[smhdwy])/g)) {
    const mult = UNITS.find(([u]) => u === m[2])?.[1];
    if (mult === undefined) return undefined;
    total += Number(m[1]) * mult;
    sawOne = true;
  }
  return sawOne && total > 0 ? total : undefined;
}

function unitTimeoutMs(unit: string, property: 'TimeoutStartUSec' | 'TimeoutStopUSec'): number | undefined {
  try {
    const out = execFileSync('systemctl', ['show', unit, '-p', property, '--value'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseSystemdTimespan(out);
  } catch {
    return undefined;
  }
}

const unitStartTimeoutMs = (unit: string): number | undefined => unitTimeoutMs(unit, 'TimeoutStartUSec');
const unitStopTimeoutMs = (unit: string): number | undefined => unitTimeoutMs(unit, 'TimeoutStopUSec');

/**
 * Does the unit allow the daemon at least as long to stop as this updater waits for a drain?
 *
 * The updater ships code. It does not, and must not, ship unit files: writing to
 * /etc/systemd/system would let the account that downloads code rewrite `User=` and hand itself
 * root, which is precisely the containment ADR 0025 exists to keep. The consequence is a settings
 * split — the deployment's behaviour lives in a file no update can reach — and one of those
 * settings is load-bearing for the update mechanism itself.
 *
 * `stop()` already refuses to call a SIGKILL a clean drain (it asks systemd for `Result`), and the
 * cutover abandons rather than forces when the drain does not finish. But if TimeoutStopSec is
 * below the drain deadline, systemd always kills first, so the abandon branch fires on every slow
 * shutdown and the deployment can never cut over while a delivery is in flight. The operator sees
 * an updater that mysteriously refuses to switch, and nothing anywhere names the cause.
 *
 * So name it. A warning, not a failure: an operator who deliberately set a short stop budget has
 * made a legitimate choice, and refusing every update over it would pin them on the running version.
 */
export function drainBudgetFinding(stopTimeoutMs: number | undefined, drainDeadlineMs: number, unit: string): string | null {
  // No answer is not a finding. systemd may be absent (a container, a developer's laptop), the unit
  // may not exist yet, or the budget may be "infinity" — none of which is evidence of a problem.
  if (stopTimeoutMs === undefined || stopTimeoutMs >= drainDeadlineMs) return null;
  const s = (ms: number): string => `${Math.round(ms / 1000)}s`;
  return (
    `${unit} allows ${s(stopTimeoutMs)} for a stop, but this updater waits ${s(drainDeadlineMs)} for a clean drain. `
    + `systemd will SIGKILL the daemon first — mid-delivery — so a cutover that should have been abandoned is instead forced. `
    + `Set TimeoutStopSec=${s(drainDeadlineMs)} or more in ${unit}, or lower MAIL_UPDATE_DRAIN_SECONDS to match.`
  );
}

export function systemdService(unit: string): ServiceControl {
  if (!/^[A-Za-z0-9@._-]+$/.test(unit)) {
    throw new UpdateConfigError(`MAIL_UPDATE_UNIT is not a plausible systemd unit name: ${JSON.stringify(unit)}`);
  }
  const systemctl = async (args: readonly string[], timeoutMs: number): Promise<number | null> => {
    const result = await runCommand('systemctl', args, { cwd: '/', env: { PATH: processEnv.PATH ?? '/usr/bin:/bin' }, timeoutMs });
    return result.timedOut ? null : result.code;
  };
  const isActive = async (): Promise<boolean> => (await systemctl(['is-active', '--quiet', unit], 15_000)) === 0;
  return {
    isActive,
    async stop(timeoutMs) {
      // Inactivity is NOT proof of a drain. systemd SIGKILLs at TimeoutStopSec and the stop job
      // then completes successfully, so a forced kill and a clean exit are indistinguishable to a
      // caller that only asks whether the unit is running — while ADR 0025 promises the cutover is
      // "abandoned rather than forced". Ask systemd HOW the unit stopped instead.
      //
      // The shipped unit now sets TimeoutStopSec=180, comfortably above the 120s drain deadline, so
      // on a deployment provisioned from deploy/hetzner-up.sh the kill should never happen. This
      // check stays because that is a fact about a file the updater cannot manage: unit files live
      // outside the version store by design, so a hand-written or older unit may carry systemd's
      // 90s default and be killed every time. `drainBudgetFinding` reports that case up front.
      const code = await systemctl(['stop', unit], timeoutMs);
      if (code !== 0) return false;
      if (await isActive()) return false;
      try {
        const result = await runCommand('systemctl', ['show', unit, '-p', 'Result', '--value'], {
          cwd: '/',
          env: { PATH: processEnv.PATH ?? '/usr/bin:/bin' },
          timeoutMs: 15_000,
        });
        // A unit that was killed reports `timeout`; one whose ExecStart exited 0 reports `success`.
        // An unreadable answer is treated as a clean stop, because refusing every cutover on a
        // systemd that will not answer would be worse than the risk it guards.
        const verdict = result.output.trim();
        return verdict === '' || verdict === 'success';
      } catch {
        return true;
      }
    },
    async start(timeoutMs) {
      await systemctl(['start', unit], timeoutMs);
      return isActive();
    },
  };
}

function buildDeps(cfg: UpdateConfig, env: Record<string, string | undefined>, io: UpdateIo): { store: VersionStore; state: StateFile; cutoverDeps: CutoverDeps } {
  const store = new VersionStore(cfg.root);
  store.ensure();
  const state = new StateFile(store.root);
  const cutoverDeps: CutoverDeps = {
    store,
    state,
    service: systemdService(env.MAIL_UPDATE_UNIT ?? 'cutiemail.service'),
    controlDbPath: env.MAIL_CONTROL_DB ?? 'control.db',
    snapshotRoot: join(store.root, 'snapshots'),
    env,
    drainDeadlineMs: cfg.drainDeadlineMs,
    probeWindowMs: cfg.probeWindowMs,
    log: (line) => io.out(`  ${sanitizeForTerminalLine(line)}`),
  };
  return { store, state, cutoverDeps };
}

function acquireDeps(cfg: UpdateConfig, store: VersionStore, io: UpdateIo): AcquireDeps {
  return {
    remote: new GitRemote(cfg.repoUrl),
    store,
    branch: cfg.branch,
    bakeMs: cfg.bakeMs,
    maxAncestryDepth: cfg.maxAncestryDepth,
    log: (line) => io.out(`  ${sanitizeForTerminalLine(line)}`),
  };
}

const days = (ms: number): string => `${(ms / 86_400_000).toFixed(1)} day(s)`;

function cmdStatus(cfg: UpdateConfig, io: UpdateIo, env: Record<string, string | undefined>): number {
  const store = new VersionStore(cfg.root);
  if (!existsSync(store.root)) {
    io.out(`update store ${store.root} does not exist yet: run \`adopt <commit>\` to start.`);
    return 0;
  }
  const state = new StateFile(store.root);
  const current = store.currentSha();
  io.out(`repository:  ${cfg.repoUrl} (${cfg.branch})`);
  io.out(`store:       ${store.root}`);
  io.out(`mode:        ${cfg.mode}`);
  io.out(`running:     ${current ?? 'nothing adopted yet — run `adopt <commit>`'}`);
  const versions = store.list();
  if (versions.length > 0) {
    io.out(`versions:    ${versions.map((v) => `${v.sha.slice(0, 12)}${v.current ? ' (current)' : ''}`).join(', ')}`);
  }

  let s;
  try {
    s = state.read();
  } catch (e) {
    io.err(`state:       UNREADABLE — ${String(e)}`);
    return 1;
  }
  io.out(`phase:       ${s.phase}`);
  if (s.lastCheckAt !== null) {
    io.out(`last check:  ${new Date(s.lastCheckAt).toISOString()} — ${sanitizeForTerminalLine(s.lastOutcome ?? '')}`);
  } else {
    io.out('last check:  never');
  }

  // Settings the updater depends on but cannot manage. `status` is where an operator looks when
  // they want to know whether this deployment is healthy, and a stop budget that silently defeats
  // the drain guarantee should not first announce itself halfway through a cutover.
  const drainFinding = drainBudgetFinding(
    unitStopTimeoutMs(env.MAIL_UPDATE_UNIT ?? 'cutiemail.service'),
    cfg.drainDeadlineMs,
    env.MAIL_UPDATE_UNIT ?? 'cutiemail.service',
  );
  if (drainFinding !== null) io.err(`unit:        ${sanitizeForTerminalLine(drainFinding)}`);

  // The alarm that matters. Everything else here is a fact; this one is a verdict.
  const stale = staleness(s, Date.now(), cfg.staleMs);
  if (stale.stale) {
    io.err('');
    io.err(`WARNING: ${stale.reason}`);
    io.err(`Updates are configured but not arriving. Check that this machine can reach ${cfg.repoUrl}, and that the ${env.MAIL_UPDATE_UNIT ?? 'cutiemail-update.timer'} timer is running.`);
    return 1;
  }
  if (stale.ageMs !== null) io.out(`staleness:   ${days(stale.ageMs)} since the last successful check (alarm at ${days(cfg.staleMs)})`);
  return 0;
}


async function cmdAdopt(cfg: UpdateConfig, args: readonly string[], io: UpdateIo): Promise<number> {
  const sha = args[0];
  if (sha === undefined) {
    io.err('adopt: which commit is this deployment running? Get it with `git rev-parse HEAD` in the checkout you installed from.');
    return 2;
  }
  if (!isCommitSha(sha)) {
    io.err(`adopt: ${JSON.stringify(sha)} is not a full 40-character lowercase commit id. Abbreviations are ambiguous, and this is the baseline every later update is compared against.`);
    return 2;
  }
  const store = new VersionStore(cfg.root);
  store.ensure();
  const existing = store.currentSha();
  if (existing === sha) {
    // Idempotent on purpose: a deployment script that lays out the store and then adopts the commit
    // it just installed is the normal path, and it must be safe to re-run. The fetch below still
    // happens, and it is the useful half — a commit that is not in the repository fails here rather
    // than silently poisoning every later comparison.
    io.out(`already tracking ${sha}; confirming it exists in the repository...`);
  } else if (existing !== null) {
    io.err(`adopt: this store already tracks ${existing}. Adopting again would discard the ancestry every update is checked against; there is nothing to fix by hand here.`);
    return 1;
  }
  const result = await adoptVersion(acquireDeps(cfg, store, io), sha);
  io.out(`adopted ${result.sha} (${result.files} files) at ${result.path}`);
  io.out(`Point the service at ${store.currentLink}/src/main.ts and restart it, then \`check\` will work.`);
  return 0;
}

/** check and apply share everything except whether they are allowed to switch. */
async function cmdCheckOrApply(cfg: UpdateConfig, io: UpdateIo, env: Record<string, string | undefined>, allowSwitch: boolean): Promise<number> {
  if (cfg.mode === 'off') {
    io.err('MAIL_UPDATE_MODE=off: this deployment is pinned. Nothing was checked.');
    return 1;
  }
  const { store, state, cutoverDeps } = buildDeps(cfg, env, io);
  store.clearStaging();

  // Before anything else: did a previous run leave this deployment part-way through a cutover?
  const note = await recover(cutoverDeps, state.read());
  if (note !== null) io.out(`recovered: ${note}`);

  const now = Date.now();
  let outcome;
  try {
    outcome = await acquireCandidate(acquireDeps(cfg, store, io));
  } catch (e) {
    // A network failure is not a finding. It is recorded so the staleness alarm can see it, and
    // reported so an operator who is watching learns why nothing happened.
    state.update((s) => recordCheck(s, now, `check failed: ${String(e)}`, { upToDate: false }));
    io.err(`check failed: ${sanitizeForTerminalLine(String(e))}`);
    return 1;
  }

  switch (outcome.kind) {
    case 'up-to-date':
      state.update((s) => recordCheck(s, now, 'up to date', { upToDate: true, sha: outcome.sha }));
      io.out(`up to date on ${outcome.sha}`);
      return 0;
    // Deliberately counted as up to date: the remote is reachable, the tip is known, and holding
    // back is the bake rule working. A branch that receives a commit most days is ALWAYS within its
    // bake window, so treating this as falling behind would raise the staleness alarm on exactly
    // the deployments that are tracking a healthy, actively-developed branch.
    case 'not-yet-baked':
      state.update((s) => recordCheck(s, now, `waiting for ${outcome.sha} to bake`, { upToDate: true, sha: outcome.sha }));
      io.out(`${outcome.sha} is available but only ${days(outcome.ageMs)} old; it becomes eligible at ${days(outcome.requiredMs)}.`);
      return 0;
    case 'refused':
      state.update((s) => recordCheck(s, now, `refused ${outcome.sha}`, { upToDate: false, sha: outcome.sha }));
      io.err(`refusing ${outcome.sha}: ${sanitizeForTerminalLine(outcome.reason)}`);
      return 1;
    case 'candidate':
      break;
  }

  const candidate = outcome.candidate;
  const current = candidate.from!;
  state.update((s) => enterPhase(recordCheck(s, now, `verifying ${candidate.sha}`, { upToDate: false, sha: candidate.sha }), 'fetched', now, { candidate: candidate.sha, previous: current }));
  io.out(`candidate ${candidate.sha} (${candidate.files} files), a descendant of ${current}. Verifying...`);

  const unitName = env.MAIL_UPDATE_UNIT ?? 'cutiemail.service';
  const startBudget = unitStartTimeoutMs(unitName);
  // Asked before the ladder rather than after it, because it is a fact about the deployment and not
  // about the candidate: an operator who is going to have to edit a unit file should hear it while
  // the update is still a choice, not once the cutover has already been abandoned.
  const drainFinding = drainBudgetFinding(unitStopTimeoutMs(unitName), cfg.drainDeadlineMs, unitName);
  if (drainFinding !== null) io.err(`  note: ${sanitizeForTerminalLine(drainFinding)}`);
  const report = await runPreflight({
    candidateDir: candidate.path,
    baselineDir: store.pathFor(current),
    sha: candidate.sha,
    controlDbPath: cutoverDeps.controlDbPath,
    env,
    workDir: join(store.root, 'preflight'),
    ...(startBudget === undefined ? {} : { startTimeoutMs: startBudget }),
    allowIrreversible: env.MAIL_UPDATE_ALLOW_IRREVERSIBLE === 'yes',
    log: (line) => io.out(`  ${sanitizeForTerminalLine(line)}`),
  });
  io.out(renderPreflight(report));
  if (!report.ok) {
    state.update((s) => enterPhase(recordCheck(s, Date.now(), `${candidate.sha} failed pre-flight`, { upToDate: false, sha: candidate.sha }), 'idle', Date.now(), { candidate: null }));
    store.clearStaging();
    return 1;
  }
  state.update((s) => enterPhase(s, 'verified', Date.now()));

  if (!allowSwitch) {
    io.out('');
    io.out(`${candidate.sha} passed every check. Nothing has been switched: run \`apply\` to cut over, or set MAIL_UPDATE_MODE=apply to have the timer do it.`);
    store.clearStaging();
    return 0;
  }

  // Only now does the candidate become a version.
  store.promote(candidate.sha);
  const result = await cutover(cutoverDeps, candidate.sha, { schemaMovedForward: report.schemaMovedForward });
  if (!result.ok) {
    state.update((s) => recordCheck(s, Date.now(), `cutover to ${candidate.sha} failed${result.reverted ? ' and was reverted' : ''}`, { upToDate: false, sha: candidate.sha }));
    io.err(`cutover failed${result.reverted ? ' and was reverted' : ''}; running ${result.running ?? 'unknown'}`);
    return 1;
  }
  state.update((s) => recordCheck(s, Date.now(), `updated to ${candidate.sha}`, { upToDate: true, sha: candidate.sha }));
  const pruned = store.prune(cfg.keepVersions, [current]);
  io.out(`updated to ${candidate.sha}${pruned.length > 0 ? `; pruned ${pruned.length} old version(s)` : ''}`);
  return 0;
}

/**
 * Clear a stuck phase.
 *
 * The deliberate escape hatch for the one thing this design refuses to guess at: a state file that
 * will not parse, or a phase nothing can move on from. It changes the recorded phase and NOTHING
 * else — not the symlink, not a database — because the situations that lead here are exactly the
 * ones where an operator has to be the one deciding what runs. Whatever history survived is kept.
 */
function cmdReset(cfg: UpdateConfig, io: UpdateIo, env: Record<string, string | undefined>): number {
  const { store, state } = buildDeps(cfg, env, io);
  let previous;
  try {
    previous = state.read();
  } catch {
    previous = INITIAL_STATE; // unreadable is precisely what this command is for
  }
  io.out(`clearing a ${previous.phase} state. What is running (${store.currentSha() ?? 'nothing'}) is NOT changed.`);
  if (previous.snapshotDir !== null) {
    io.out(`A pre-cutover snapshot may still be at ${previous.snapshotDir}. It holds copies of every secret: check it, then remove it.`);
  }
  state.write(enterPhase(previous, 'idle', Date.now(), { candidate: null, snapshotDir: null }));
  store.clearStaging();
  io.out('Run `status` to confirm, then `check`.');
  return 0;
}

export async function runUpdate(args: readonly string[], io: UpdateIo, env: Record<string, string | undefined>): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  let cfg: UpdateConfig;
  try {
    cfg = updateConfigFromEnv(env);
  } catch (e) {
    io.err(e instanceof UpdateConfigError ? e.message : String(e));
    return 2;
  }

  // `status` is the only read-only verb, so it is the only one that may run alongside another. Every
  // other command touches the version store, and two of them at once is not merely wasteful: each
  // run begins by recovering an interrupted cutover, and one process cannot tell another process's
  // legitimate in-progress switch from a crashed one. The newcomer reverts it. See run-lock.ts.
  if (command === 'status') return cmdStatus(cfg, io, env);
  let lock: RunLock;
  try {
    lock = acquireRunLock(cfg.root);
  } catch (e) {
    if (e instanceof RunLockError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  try {
    return await dispatch();
  } finally {
    lock.release();
  }

  async function dispatch(): Promise<number> {
  switch (command) {
    case 'adopt':
      return cmdAdopt(cfg, rest, io);
    case 'check':
      return cmdCheckOrApply(cfg, io, env, false);
    case 'apply':
      return cmdCheckOrApply(cfg, io, env, true);
    case 'auto':
      // What the timer runs. The configuration decides, so switching a deployment from reporting to
      // acting is a one-word change and not a different unit file.
      if (cfg.mode === 'off') {
        io.out('MAIL_UPDATE_MODE=off: nothing to do.');
        return 0;
      }
      return cmdCheckOrApply(cfg, io, env, cfg.mode === 'apply');
    case 'reset':
      return cmdReset(cfg, io, env);
    default:
      io.err(`unknown command: ${sanitizeForTerminalLine(String(command))}`);
      io.err(USAGE);
      return 2;
  }
  }
}

if (invokedDirectly(import.meta.url, argv[1])) {
  const io: UpdateIo = {
    out: (line) => void stdout.write(`${line}\n`),
    err: (line) => void stderr.write(`${line}\n`),
  };
  runUpdate(argv.slice(2), io, processEnv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      stderr.write(`fatal: ${(e as Error).stack ?? String(e)}\n`);
      process.exitCode = 1;
    });
}
