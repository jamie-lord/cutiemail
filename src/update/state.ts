/**
 * The cutover state machine, written to disk so a power cut is recoverable rather than ambiguous.
 *
 *   idle → fetched → verified → snapshotted → draining → switching → probing → confirmed
 *                                                  ↘         ↘          ↘
 *                                                       reverting → idle
 *
 * Only the phases after `snapshotted` have changed anything outside the staging area, and only they
 * need recovery. The rest exist so that a report can say where a run stopped.
 *
 * WHY THIS FILE EXISTS AT ALL. Everything in the cutover is individually atomic — the symlink swap
 * is a rename, the snapshot is complete or absent — but the SEQUENCE is not. A machine that loses
 * power between the swap and the probe comes back running a version nobody ever confirmed, and
 * without a record of what it was doing there is no way to tell that from a healthy deployment. The
 * next run reads this and knows.
 *
 * `switching` is the phase worth being careful about, and the design makes it decidable rather than
 * ambiguous: the swap is a single `rename(2)`, so `current` points either at the old version or the
 * new one and never at anything in between. Recovery reads the link and continues from whichever it
 * finds — there is no third case to guess at.
 *
 * A CORRUPT STATE FILE IS NOT TREATED AS "no state". A file that will not parse while the phase it
 * held might have been `switching` is exactly the situation where assuming the safe-looking answer
 * is wrong, so it raises and waits for an operator. A file that is simply ABSENT is a first run,
 * which is a different thing entirely.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class UpdateStateError extends Error {}

export type Phase =
  | 'idle'
  | 'fetched'
  | 'verified'
  | 'snapshotted'
  | 'draining'
  | 'switching'
  | 'probing'
  | 'confirmed'
  | 'reverting';

/** Phases where something outside the staging area has already been changed. */
export const RECOVERABLE_PHASES: readonly Phase[] = ['snapshotted', 'draining', 'switching', 'probing', 'reverting'];

export interface HistoryEntry {
  readonly at: number;
  readonly sha: string | null;
  readonly outcome: string;
}

export interface UpdateState {
  readonly version: 1;
  readonly phase: Phase;
  /** The version being moved TO, while a cutover is in flight. */
  readonly candidate: string | null;
  /** The version being moved FROM, so a revert knows where to go back to. */
  readonly previous: string | null;
  /** Where the pre-cutover database snapshot lives, if one was taken. */
  readonly snapshotDir: string | null;
  /**
   * Whether the candidate's migration moved a schema forward.
   *
   * This is what decides whether a rollback can just flip the symlink back or has to restore the
   * snapshot as well: an older build refuses to open a database from the future, so reverting onto
   * a migrated database would leave a version that cannot start at all.
   */
  readonly schemaMovedForward: boolean;
  readonly enteredAt: number;
  /** When a check FIRST ran. Never updated, so the never-yet-up-to-date case can age from it. */
  readonly firstCheckAt: number | null;
  /** When a check last RAN, successfully or not. */
  readonly lastCheckAt: number | null;
  /**
   * When this deployment was last actually up to date — on the branch tip, or deliberately waiting
   * for a tip that has not baked yet. The staleness alarm measures from here.
   *
   * NOT "when a check last reached the remote", which is what this used to mean and is a different
   * question. A check that fetched a candidate and then failed every rung reached the remote and
   * left the deployment exactly as un-updated as one that could not resolve DNS.
   */
  readonly lastSuccessAt: number | null;
  readonly lastOutcome: string | null;
  readonly history: readonly HistoryEntry[];
}

const HISTORY_LIMIT = 20;

export const INITIAL_STATE: UpdateState = {
  version: 1,
  phase: 'idle',
  candidate: null,
  previous: null,
  snapshotDir: null,
  schemaMovedForward: false,
  enteredAt: 0,
  firstCheckAt: null,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastOutcome: null,
  history: [],
};

const PHASES = new Set<string>([
  'idle',
  'fetched',
  'verified',
  'snapshotted',
  'draining',
  'switching',
  'probing',
  'confirmed',
  'reverting',
]);

/** Validate a parsed state, because a field we merely assume is a field an operator can mistype. */
function parseState(raw: unknown, path: string): UpdateState {
  if (typeof raw !== 'object' || raw === null) throw new UpdateStateError(`${path} is not an object`);
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new UpdateStateError(`${path} has version ${String(o.version)}, which this build does not understand`);
  if (typeof o.phase !== 'string' || !PHASES.has(o.phase)) throw new UpdateStateError(`${path} has an unknown phase ${JSON.stringify(o.phase)}`);
  const sha = (v: unknown, field: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || !/^[0-9a-f]{40}$/.test(v)) throw new UpdateStateError(`${path}: ${field} is not a commit id`);
    return v;
  };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const history: HistoryEntry[] = [];
  if (Array.isArray(o.history)) {
    for (const entry of o.history) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      history.push({ at: num(e.at) ?? 0, sha: typeof e.sha === 'string' ? e.sha : null, outcome: String(e.outcome ?? '') });
    }
  }
  return {
    version: 1,
    phase: o.phase as Phase,
    candidate: sha(o.candidate, 'candidate'),
    previous: sha(o.previous, 'previous'),
    snapshotDir: typeof o.snapshotDir === 'string' ? o.snapshotDir : null,
    schemaMovedForward: o.schemaMovedForward === true,
    enteredAt: num(o.enteredAt) ?? 0,
    // Absent in state written by a build before this field existed; the first check after an upgrade
    // seeds it, which ages the alarm from then rather than from never.
    firstCheckAt: num(o.firstCheckAt),
    lastCheckAt: num(o.lastCheckAt),
    lastSuccessAt: num(o.lastSuccessAt),
    lastOutcome: typeof o.lastOutcome === 'string' ? o.lastOutcome : null,
    history,
  };
}

export class StateFile {
  readonly path: string;

  constructor(root: string) {
    this.path = join(root, 'state.json');
  }

  /** The recorded state, or the initial one when there has never been a run. */
  read(): UpdateState {
    if (!existsSync(this.path)) return INITIAL_STATE;
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      throw new UpdateStateError(`cannot read ${this.path}: ${String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Deliberately NOT "start over". The phase this file held may have been `switching`, and
      // assuming the safe-looking answer is how a half-finished cutover becomes permanent.
      throw new UpdateStateError(
        `${this.path} is not valid JSON. Refusing to guess what this deployment was doing: inspect it, then remove it to start over.`,
      );
    }
    return parseState(parsed, this.path);
  }

  /**
   * Replace the state, atomically.
   *
   * Write to a temporary file, flush it to the disk, then rename over the target. Without the
   * `fsync` the rename can reach the disk before the bytes do, and a power cut leaves a state file
   * that exists, is named correctly, and contains nothing — which the reader above would then
   * refuse, blocking every future run until someone looks.
   */
  write(state: UpdateState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o755 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
      const fd = openSync(tmp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Read, transform, write. The only way phases are meant to change. */
  update(fn: (state: UpdateState) => UpdateState): UpdateState {
    const next = fn(this.read());
    this.write(next);
    return next;
  }
}

/** Move to a phase, stamping when it was entered. */
export function enterPhase(state: UpdateState, phase: Phase, now: number, patch: Partial<UpdateState> = {}): UpdateState {
  return { ...state, ...patch, phase, enteredAt: now };
}

/**
 * Record the outcome of a check run, keeping the history bounded.
 *
 * `upToDate` means what the staleness alarm needs to know: is this deployment ON the branch tip, or
 * deliberately waiting for a tip that has not baked yet? Reaching the remote is not the same
 * question and was the wrong one to ask — a check that fetched a candidate and then failed every
 * rung reached the remote and updated nothing, yet kept refreshing the clock that exists to notice
 * exactly that.
 */
export function recordCheck(
  state: UpdateState,
  now: number,
  outcome: string,
  opts: { readonly upToDate: boolean; readonly sha?: string | null } = { upToDate: false },
): UpdateState {
  return {
    ...state,
    firstCheckAt: state.firstCheckAt ?? now,
    lastCheckAt: now,
    lastSuccessAt: opts.upToDate ? now : state.lastSuccessAt,
    lastOutcome: outcome,
    history: [...state.history, { at: now, sha: opts.sha ?? null, outcome }].slice(-HISTORY_LIMIT),
  };
}

/**
 * How long since this deployment was last up to date, and whether that is now a problem.
 *
 * The mirror image of the bake rule. Anyone who can simply block access to the remote otherwise
 * pins a deployment on an old version forever and nothing notices — the same rot, arriving through
 * the mechanism meant to prevent it.
 *
 * TWO THINGS HERE HAVE TO BE THE RIGHT ONES, and both were wrong. The clock has to measure from
 * being up to date rather than from touching the remote, or every failing check refreshes it. And
 * the never-yet-up-to-date case has to age from the FIRST attempt, not the last: falling back to
 * `lastCheckAt` — which every attempt refreshes — meant the age was always about zero, so the
 * branch below could never fire and a deployment whose checks had never once succeeded reported
 * itself perfectly healthy forever. That is the precise scenario ADR 0025 names this alarm for.
 */
export function staleness(state: UpdateState, now: number, staleMs: number): { ageMs: number | null; stale: boolean; reason: string | null } {
  const since = state.lastSuccessAt ?? state.firstCheckAt;
  if (since === null) return { ageMs: null, stale: false, reason: null };
  const ageMs = now - since;
  if (ageMs < staleMs) return { ageMs, stale: false, reason: null };
  const days = Math.floor(ageMs / 86_400_000);
  return {
    ageMs,
    stale: true,
    reason:
      state.lastSuccessAt === null
        ? `this deployment has NEVER been up to date, and the first check was ${days} day(s) ago. Nothing is arriving. Last outcome: ${state.lastOutcome ?? 'unknown'}`
        : `this deployment was last up to date ${days} day(s) ago. Updates are not arriving — the remote may be unreachable, or every check may be failing — and it is quietly falling behind. Last outcome: ${state.lastOutcome ?? 'unknown'}`,
  };
}
