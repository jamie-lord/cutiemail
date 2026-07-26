/**
 * The verification ladder (ADR 0025, rungs 3–6): what a candidate must survive before anyone
 * considers switching to it.
 *
 * The design principle is that each rung is stronger evidence than the last, and that the expensive
 * rungs run against a copy of REAL data rather than a fixture. Most auto-updaters stop at "the
 * process started", which is the rung that proves the least — it does not know whether your schema
 * migration works, how long it takes, whether your configuration still satisfies the new version,
 * or whether a single message survived.
 *
 *   3  shape          is this a cutiemail version, and will this machine's Node run it?
 *   4  own tests      the regression gate the project already maintains
 *   5  isolated boot  a synthetic config and a scratch database: does the entry point work at all?
 *   6a migration      YOUR data, YOUR configuration: does it migrate, how long does it take, and is
 *                     everything still there afterwards, byte for byte?
 *   6b mail path      the same data again, this time exercised: authenticated submission, delivery,
 *                     IMAP read-back, and the SMTP conformance suite against its own listener
 *
 * Rung 6 is split into two boots on purpose. The migration check has to be able to say "nothing
 * changed", and it can only say that if nothing was ASKED to change — a boot that also delivers
 * mail cannot distinguish a migration that lost a message from a probe that added one. So the first
 * boot migrates and is measured, and the second does the work.
 *
 * Two safety rules are absolute in rung 6, because it runs a downloaded program with production
 * configuration:
 *
 *   - `MAIL_OUTBOUND=hold` is forced. The snapshot contains the outbound queue, and a candidate
 *     booted against it in `deliver` mode would relay every queued message a second time. This is
 *     the single most dangerous thing about testing with real data, which is why it is a hard
 *     override here and why the census comparison treats an unchanged queue depth as EVIDENCE
 *     rather than as a formality.
 *   - Loopback only, ephemeral ports. The candidate never binds 25, 587 or 993 and is never
 *     reachable from off the machine.
 *
 * What this cannot do: rung 4 runs tests the candidate itself ships, so it is a regression gate and
 * not a security boundary — a hostile version would ship passing tests. What stops a hostile
 * version is provenance (acquire.ts), and nothing here should be read as a substitute for it.
 */

import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountRegistry } from '../store/account-registry.ts';
import { runSelftest } from '../ops/selftest.ts';
import { runSuite } from '../conformance/runner.ts';
import { connectOptions } from '../conformance/config.ts';
import { withPostmasterConvention, type Fixture } from '../conformance/fixture.ts';
import { ALL_CASES } from '../corpus/index.ts';
import { isFinding, explain } from '../conformance/outcome.ts';
import { checkShape } from './shape.ts';
import { startCandidate, type RunningCandidate } from './candidate-process.ts';
import { checkExecutable } from './executable.ts';
import { censusOf, compareCensus, schemaMovedForward, takeSnapshot, type Census, type Snapshot } from './snapshot.ts';

export interface RungResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface PreflightReport {
  readonly sha: string;
  readonly rungs: readonly RungResult[];
  readonly ok: boolean;
  /**
   * How long the candidate took from spawn to serving against a copy of the real data. This is
   * downtime later, and a ten-minute migration is something to know before taking the service down
   * rather than after.
   */
  readonly migrationMs: number | null;
  /** Whether the candidate moved a schema forward, which decides whether rollback needs a restore. */
  readonly schemaMovedForward: boolean;
  /** Things that reduced the fidelity of the check without failing it. */
  readonly warnings: readonly string[];
}

export interface PreflightOptions {
  readonly candidateDir: string;
  /**
   * The checkout currently running, used as the conformance baseline.
   *
   * Without it the corpus can only report, because there is no way to tell a gap the candidate
   * introduced from one the deployment has always had — and refusing an update over a pre-existing
   * gap would pin the deployment on the very version that has it.
   */
  readonly baselineDir?: string;
  readonly sha: string;
  /** The LIVE control database. It is snapshotted, never opened for writing. */
  readonly controlDbPath: string;
  /** The daemon's real environment, as the basis for rung 6's configuration. */
  readonly env: Record<string, string | undefined>;
  /** Scratch space for snapshots and the isolated boot. Removed afterwards. */
  readonly workDir: string;
  readonly bootTimeoutMs?: number;
  readonly log?: (line: string) => void;
  /**
   * The service unit's own start budget, in milliseconds, when it can be discovered.
   *
   * Rung 6a measures how long the candidate takes to migrate and serve your data. That number is
   * only meaningful next to the budget systemd will actually allow: a migration that takes longer
   * than TimeoutStartSec is killed half-way through, on the live databases, during the cutover.
   */
  readonly startTimeoutMs?: number;
  /**
   * Accept an update whose migration the running version cannot read afterwards.
   *
   * Off by default. Reverting is a symlink rename back, and that only restores the CODE — if the
   * data has moved to a schema the old version cannot open, the rename produces a dead server and
   * the only way back is restoring the pre-cutover snapshot.
   */
  readonly allowIrreversible?: boolean;
}

const DEFAULT_BOOT_TIMEOUT_MS = 5 * 60_000;
/** The domain the scratch boots announce. Reserved (RFC 2606), so nothing can resolve or leak. */
const SCRATCH_DOMAIN = 'preflight.one.example';

/** Is this path readable by the current process? */
function readable(path: string | undefined): boolean {
  if (path === undefined || path === '') return false;
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Only the environment a child genuinely needs, so nothing leaks in by accident. */
function baseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_PATH']) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The candidate's configuration for rung 6: the real one, with the dangerous parts overridden.
 *
 * MAIL_UPDATE_* is dropped so the candidate cannot start updating anything itself, which would be a
 * program we are still deciding whether to trust reaching out to the network and rewriting the
 * version store that is currently deciding its fate.
 */
export function candidateEnv(
  opts: Pick<PreflightOptions, 'env'>,
  snapshot: Pick<Snapshot, 'dir' | 'controlDb'>,
  warnings: string[],
): Record<string, string> {
  const env = baseEnv(opts.env);
  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    if (!key.startsWith('MAIL_')) continue;
    if (key.startsWith('MAIL_UPDATE_')) continue;
    env[key] = value;
  }
  env.MAIL_CONTROL_DB = snapshot.controlDb;
  // Only reachable if a new account gets seeded, but it must land in the snapshot either way.
  env.MAIL_DB = join(snapshot.dir, 'mail.db');
  // THE override. See the module comment: the snapshot contains the outbound queue.
  env.MAIL_OUTBOUND = 'hold';

  // The real certificate and DKIM key are used when this process can read them. In a correct
  // deployment the updater is a different user from the daemon and those files are 0600, so it
  // usually cannot — the check then falls back to the bundled loopback-only development
  // certificate. That is a real reduction in fidelity, so it is stated rather than glossed over.
  if (!readable(env.MAIL_TLS_CERT) || !readable(env.MAIL_TLS_KEY)) {
    if (env.MAIL_TLS_CERT !== undefined) {
      warnings.push('the configured TLS certificate is not readable by the updater, so the candidate was checked with the bundled development certificate instead');
    }
    delete env.MAIL_TLS_CERT;
    delete env.MAIL_TLS_KEY;
  }
  if (env.MAIL_DKIM_KEY !== undefined && !readable(env.MAIL_DKIM_KEY)) {
    warnings.push('the configured DKIM key is not readable by the updater, so the candidate was checked without outbound signing');
    delete env.MAIL_DKIM_KEY;
    delete env.MAIL_DKIM_SELECTOR;
  }
  return env;
}

/**
 * Give the updater a way in to the snapshot: an app password on the first enabled account.
 *
 * Accounts store SCRAM material, so no password can be recovered — which is the right property and
 * also means the mail-path probe needs a credential of its own. Minting one is safe HERE and only
 * here: this is a copy that is destroyed minutes later, and the live registry is untouched.
 * Returns null when the snapshot has no enabled account to probe with.
 */
function mintProbeCredential(snapshot: Snapshot): { login: string; password: string } | null {
  const db = new DatabaseSync(snapshot.controlDb);
  try {
    const registry = AccountRegistry.open(db);
    const account = registry.list().find((a) => a.enabled);
    if (account === undefined) return null;
    const password = registry.addAppPassword(account.login, `preflight-${randomUUID().slice(0, 8)}`, Date.now());
    return { login: account.login, password };
  } finally {
    db.close();
  }
}

export interface ConformanceRun {
  readonly total: number;
  readonly inconclusive: number;
  /** Test ids that produced a finding, so two runs can be compared. */
  readonly findings: ReadonlyMap<string, string>;
}

/**
 * A run where EVERY case was inconclusive verified nothing.
 *
 * Without this the false green is silent and total: a listener that accepts connections and then
 * says nothing makes every case inconclusive, which produces no findings, which the regression
 * comparison reads as "no new findings" and passes. Readiness is measured by whether the ports
 * accept (candidate-process.ts), and this is the blind spot in that measurement.
 */
export function conformanceVerifiedNothing(run: ConformanceRun): boolean {
  return run.total > 0 && run.inconclusive === run.total;
}

/**
 * Run the SMTP conformance corpus against a listener.
 *
 * Against a scratch database with the bundled dev account, so the answer is a property of the CODE
 * and not of one deployment's data — which is what makes two runs comparable.
 */
async function runConformance(port: number, domain: string, validRecipient: string): Promise<ConformanceRun> {
  const fixture: Fixture = withPostmasterConvention(
    { clientDomain: 'preflight.one.example', validRecipient, source: 'operator-declared' },
    domain,
  );
  const results = await runSuite(ALL_CASES, {
    connect: connectOptions({ name: 'candidate', serverDomain: domain, host: '127.0.0.1', port, tls: 'none', fixture }),
    fixture,
  });
  const findings = new Map<string, string>();
  for (const r of results) if (isFinding(r.outcome)) findings.set(r.testId, explain(r));
  return { total: results.length, inconclusive: results.filter((r) => r.outcome === 'inconclusive').length, findings };
}

/** Capture the io a command writes, for the report. */
function capture(): { io: { out: (l: string) => void; err: (l: string) => void }; text: () => string } {
  const lines: string[] = [];
  return {
    io: { out: (l) => lines.push(l), err: (l) => lines.push(l) },
    text: () => lines.join('\n'),
  };
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const log = opts.log ?? ((): void => {});
  const rungs: RungResult[] = [];
  const warnings: string[] = [];
  let migrationMs: number | null = null;
  let movedForward = false;

  /** Run one rung, recording its time. A false return stops the ladder. */
  const rung = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string }): Promise<boolean> => {
    const started = Date.now();
    let result: { ok: boolean; detail: string };
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e) };
    }
    const entry = { name, ok: result.ok, detail: result.detail, ms: Date.now() - started };
    rungs.push(entry);
    log(`${result.ok ? 'ok  ' : 'FAIL'} ${name} (${entry.ms}ms)${result.ok ? '' : `: ${result.detail.split('\n')[0]}`}`);
    return result.ok;
  };

  mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
  // A holder rather than plain locals: these are set inside rung closures, and the cleanup below
  // has to see whatever they ended up as however the ladder exited.
  const state: {
    snapshot: Snapshot | null;
    probe: { login: string; password: string } | null;
    before: Census | null;
  } = { snapshot: null, probe: null, before: null };
  try {
    // ---- Rung 3: shape -----------------------------------------------------------------------
    if (
      !(await rung('shape', () => {
        const shape = checkShape(opts.candidateDir);
        return { ok: shape.ok, detail: shape.ok ? `${shape.files} files, required modules present, engines.node satisfied` : shape.findings.join('; ') };
      }))
    ) return report();

    // ---- Rung 4: does this tree run on THIS machine? -----------------------------------------
    //
    // This used to run the candidate's entire test suite. See executable.ts for why that was the
    // wrong question asked at great expense, and why exactly one thing survives from it.
    if (
      !(await rung('runs on this machine', async () => {
        const result = await checkExecutable(opts.candidateDir, baseEnv(opts.env));
        return { ok: result.ok, detail: result.detail };
      }))
    ) return report();

    // ---- Rung 5: boot in isolation, and conformance measured as a REGRESSION -------------------
    //
    // Two things happen here, both on a synthetic configuration and an empty database. First: does
    // the entry point work at all? That separates "the new version is broken" from "your data or
    // configuration is the problem", which rung 6 cannot do on its own.
    //
    // Second, the SMTP conformance corpus — but compared against the version currently running,
    // not against perfection. An update gate has to measure REGRESSION. A conformance gap that the
    // running version already has is not a reason to refuse the update: refusing would pin the
    // deployment forever on the very version that has the gap, and the operator would never get
    // the fix. A gap the candidate INTRODUCES is a different matter entirely.
    if (
      !(await rung('isolated boot and conformance', async () => {
        const bootOn = async (dir: string, name: string): Promise<{ ready: number; conformance: ConformanceRun }> => {
          const scratch = join(opts.workDir, `scratch-${name}`);
          rmSync(scratch, { recursive: true, force: true });
          mkdirSync(scratch, { recursive: true, mode: 0o700 });
          const running = await startCandidate({
            dir,
            env: { ...baseEnv(opts.env), MAIL_CONTROL_DB: join(scratch, 'control.db'), MAIL_DOMAIN: SCRATCH_DOMAIN, MAIL_OUTBOUND: 'hold' },
            readyTimeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
            log,
          });
          try {
            // The empty-registry loopback fallback seeds demo/demo, so there is a deliverable
            // recipient without provisioning anything.
            return { ready: running.readyMs, conformance: await runConformance(running.ports.smtp, SCRATCH_DOMAIN, `demo@${SCRATCH_DOMAIN}`) };
          } finally {
            await running.stop();
            rmSync(scratch, { recursive: true, force: true });
          }
        };

        const candidate = await bootOn(opts.candidateDir, 'candidate');
        if (conformanceVerifiedNothing(candidate.conformance)) {
          return { ok: false, detail: `all ${candidate.conformance.total} conformance cases were inconclusive: the candidate's inbound listener answered nothing` };
        }

        if (opts.baselineDir === undefined) {
          // With nothing to compare against, findings are reported and not enforced. Saying so is
          // the honest option; treating them as regressions would be a guess.
          for (const id of candidate.conformance.findings.keys()) {
            warnings.push(`conformance finding ${id} was not checked against the running version, because no baseline checkout was given`);
          }
          return {
            ok: true,
            detail: `served in ${candidate.ready}ms on an empty database; ${candidate.conformance.total} conformance cases, ${candidate.conformance.findings.size} finding(s), uncompared`,
          };
        }

        const baseline = await bootOn(opts.baselineDir, 'baseline');
        const introduced = [...candidate.conformance.findings.keys()].filter((id) => !baseline.conformance.findings.has(id));
        const fixed = [...baseline.conformance.findings.keys()].filter((id) => !candidate.conformance.findings.has(id));
        for (const id of candidate.conformance.findings.keys()) {
          if (baseline.conformance.findings.has(id)) warnings.push(`conformance finding ${id} is present in both the running version and the candidate; not a regression, but still a finding`);
        }
        if (introduced.length > 0) {
          return {
            ok: false,
            detail:
              `the candidate introduces ${introduced.length} conformance finding(s) the running version does not have:\n` +
              introduced.map((id) => candidate.conformance.findings.get(id)!).join('\n\n'),
          };
        }
        return {
          ok: true,
          detail:
            `served in ${candidate.ready}ms on an empty database; ${candidate.conformance.total} conformance cases, no new findings against the running version` +
            (fixed.length > 0 ? ` (and it fixes ${fixed.length}: ${fixed.join(', ')})` : ''),
        };
      }))
    ) return report();

    // ---- Rung 6a: migrate a copy of the real data ---------------------------------------------
    if (
      !(await rung('migration against your data', async () => {
        const snapshot = takeSnapshot(opts.controlDbPath, join(opts.workDir, 'snapshot'));
        state.snapshot = snapshot;
        state.probe = mintProbeCredential(snapshot);
        if (state.probe === null) warnings.push('the snapshot has no enabled account, so the mail path could not be exercised');
        const before = censusOf(snapshot);
        state.before = before;
        const env = candidateEnv(opts, snapshot, warnings);
        const candidate = await startCandidate({ dir: opts.candidateDir, env, readyTimeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS, log });
        migrationMs = candidate.readyMs;
        // Stop before measuring: a census of a database another process has open would be racing
        // the very writes it is trying to rule out.
        await candidate.stop();
        const after = censusOf(snapshot);
        movedForward = schemaMovedForward(before, after);
        const findings = compareCensus(before, after);
        const scale = `${before.accounts.length} account(s), ${before.mailboxes.length} mailbox(es), ${before.mailboxes.reduce((n, m) => n + m.messages, 0)} message(s), ${snapshot.bytes} bytes`;
        return findings.length > 0
          ? { ok: false, detail: findings.join('\n') }
          : {
              ok: true,
              detail:
                `migrated and served in ${migrationMs}ms over ${scale}; everything intact ` +
                `(${before.digestIsFull ? 'full' : 'sampled'} message digest), queue depth ${before.queueDepth} unchanged` +
                (movedForward ? '; the schema moved FORWARD, so a rollback would need the snapshot restored' : '') +
                budgetNote(migrationMs, opts.startTimeoutMs, warnings),
            };
      }))
    ) return report();

    // ---- Rung 6b: exercise the mail path against that data ------------------------------------
    if (
      !(await rung('mail path against your data', async () => {
        const { snapshot, probe } = state;
        if (snapshot === null || probe === null) return { ok: true, detail: 'no enabled account to probe with; skipped' };
        const env = candidateEnv(opts, snapshot, warnings);
        const domain = env.MAIL_DOMAIN ?? 'mail.example.com';
        let candidate: RunningCandidate | null = null;
        try {
          candidate = await startCandidate({ dir: opts.candidateDir, env, readyTimeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS, log });
          const running = candidate;
          const selftest = capture();
          const code = await runSelftest(
            [probe.login],
            selftest.io,
            {
              MAIL_HOST: '127.0.0.1',
              MAIL_DOMAIN: domain,
              MAIL_SUBMISSION_PORT: String(running.ports.submission),
              MAIL_IMAP_PORT: String(running.ports.imap),
            },
            probe.password,
          );
          if (code !== 0) return { ok: false, detail: `selftest against the candidate failed:\n${selftest.text()}` };
          return { ok: true, detail: `authenticated submission, local delivery and IMAP read-back all work against ${probe.login}'s real mailbox` };
        } finally {
          await candidate?.stop();
        }
      }))
    ) return report();

    // ---- Rung 6c: can we get BACK? -----------------------------------------------------------
    //
    // The rung the ladder was missing, and the one everything else leans on.
    //
    // The pre-flight cannot test the systemd sandbox: it spawns the candidate itself, so
    // ProtectSystem, SystemCallFilter, the capability bounding set and ReadWritePaths are all
    // absent. The cutover CAN and does — it restarts the real unit and then pushes a real message
    // through the real ports — and its answer to a failure is to rename the symlink back. So the
    // sandbox, and every other environmental difference nobody has thought of, is covered by
    // revert working. That makes revert the load-bearing guarantee of the whole design.
    //
    // And revert only restores the CODE. If the migration has moved the data to a schema the
    // running version cannot open, renaming the symlink back produces a dead server, and the only
    // way home is restoring the pre-cutover snapshot — during an incident, by hand.
    //
    // So: boot the version that is running now against the snapshot the candidate has just
    // migrated. Not inferred from a version number — schemaMovedForward already reports that, and
    // a number going up says nothing about whether the old code can still read what is there. The
    // old binary either opens it or it does not.
    if (
      !(await rung('the running version can still read the migrated data', async () => {
        const { snapshot } = state;
        if (snapshot === null) return { ok: true, detail: 'no snapshot to check' };
        if (opts.baselineDir === undefined) {
          warnings.push('reversibility was not checked: no checkout of the running version was given');
          return { ok: true, detail: 'skipped; no baseline checkout' };
        }
        let baseline: RunningCandidate | null = null;
        try {
          baseline = await startCandidate({
            dir: opts.baselineDir,
            env: candidateEnv(opts, snapshot, warnings),
            readyTimeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
            log,
          });
          return { ok: true, detail: `the running version served the migrated data in ${baseline.readyMs}ms, so a revert is a symlink rename and nothing more` };
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          if (opts.allowIrreversible === true) {
            warnings.push(`this update is ONE-WAY: the running version could not open the migrated data (${why}). Proceeding because it was explicitly allowed; a rollback will need the pre-cutover snapshot restored.`);
            return { ok: true, detail: 'one-way migration, allowed by configuration' };
          }
          return {
            ok: false,
            detail:
              `the running version could not open the data after the candidate migrated it: ${why}\n` +
              'That makes this update ONE-WAY. Reverting renames the symlink back to code that can no ' +
              'longer read its own database, so the only way home would be restoring the pre-cutover ' +
              'snapshot by hand, during whatever incident prompted the revert. Set ' +
              'MAIL_UPDATE_ALLOW_IRREVERSIBLE=yes to accept that trade deliberately.',
          };
        } finally {
          await baseline?.stop();
        }
      }))
    ) return report();

    return report();
  } finally {
    // The snapshot holds every secret the live system holds. It goes whatever happened.
    state.snapshot?.destroy();
    rmSync(opts.workDir, { recursive: true, force: true });
  }

  function report(): PreflightReport {
    return {
      sha: opts.sha,
      rungs,
      ok: rungs.every((r) => r.ok),
      migrationMs,
      schemaMovedForward: movedForward,
      warnings,
    };
  }
}

/** Render a report for an operator. */
export function renderPreflight(report: PreflightReport): string {
  const lines = [`pre-flight for ${report.sha}: ${report.ok ? 'PASSED' : 'FAILED'}`];
  for (const rung of report.rungs) {
    lines.push(`  ${rung.ok ? 'ok  ' : 'FAIL'} ${rung.name} (${rung.ms}ms)`);
    for (const line of rung.detail.split('\n')) if (line !== '') lines.push(`        ${line}`);
  }
  if (report.migrationMs !== null) {
    lines.push('', `The candidate migrated and served your data in ${report.migrationMs}ms. That is how long the cutover will be unavailable.`);
  }
  for (const warning of report.warnings) lines.push(`  note: ${warning}`);
  return lines.join('\n');
}

/**
 * What the measured migration time means next to the budget systemd will actually allow.
 *
 * A number on its own ("migrated in 204ms") reads as reassurance and carries no judgement. The
 * judgement that matters is whether the real cutover will fit inside `TimeoutStartSec`, because a
 * migration killed half-way through happens on the LIVE databases, not a copy.
 *
 * The margin is deliberately wide. The pre-flight migrates a snapshot on an idle machine; the real
 * one runs during a restart, on a box that may be doing other work, against data that has grown
 * since. Being close to the limit here is already too close.
 */
function budgetNote(migrationMs: number, startTimeoutMs: number | undefined, warnings: string[]): string {
  if (startTimeoutMs === undefined || startTimeoutMs <= 0) return '';
  const share = migrationMs / startTimeoutMs;
  if (share >= 0.5) {
    warnings.push(
      `the migration took ${migrationMs}ms against a ${startTimeoutMs}ms start timeout (${Math.round(share * 100)}% of the budget). ` +
        'The real cutover runs on live databases that will only be bigger; raise TimeoutStartSec on the unit before that margin closes.',
    );
  }
  return `; ${Math.round(share * 100)}% of the unit's ${startTimeoutMs}ms start budget`;
}
