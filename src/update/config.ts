/**
 * The updater's configuration (ADR 0025).
 *
 * Read from the environment like the daemon's, and with the same stance: a value that is merely
 * *wrong* falls back to a documented default, but a value that would silently invert a safety
 * property FAILS LOUD. `MAIL_UPDATE_MODE=aply` must not quietly mean "off", and it must not quietly
 * mean "apply" either — the operator gets an error naming what they typed.
 *
 * Separated from `main.ts`'s `configFromEnv` on purpose. The updater is a different program with a
 * different user and different privileges; sharing a config object would be the first step towards
 * sharing a process, which is exactly what ADR 0025 forbids.
 */

export class UpdateConfigError extends Error {}

/**
 * How much autonomy the updater has.
 *
 * - `off`     — nothing runs. Even a hand-run `apply` refuses, so a deployment can be pinned.
 * - `check`   — fetch, verify and report, but never switch. The default: the mechanism proves
 *               itself on real deployments before it is given the keys (ADR 0025).
 * - `apply`   — check, and if every rung of the ladder passes, cut over.
 */
export type UpdateMode = 'off' | 'check' | 'apply';

export interface UpdateConfig {
  /** Where the source of truth lives. HTTPS only (see `parseRepoUrl`). */
  readonly repoUrl: string;
  /** The branch whose tip is a release. */
  readonly branch: string;
  /** The version store root: checkouts, the `current` symlink, state, snapshots. */
  readonly root: string;
  readonly mode: UpdateMode;
  /**
   * How old a commit must be before it is eligible. A mistake merged to `main` gets this long to be
   * noticed and reverted before it reaches any deployment.
   */
  readonly bakeMs: number;
  /**
   * Not having been able to check for this long is reported as a problem. Without it, anyone who can
   * simply block access to the remote pins a deployment on an old version forever and nothing
   * notices — the same rot, arriving through the mechanism meant to prevent it.
   */
  readonly staleMs: number;
  /** How many superseded versions to keep on disk for rollback. */
  readonly keepVersions: number;
  /** How long to wait for the running daemon to finish in-flight work before abandoning a cutover. */
  readonly drainDeadlineMs: number;
  /** How long the new version must stay healthy after the switch before it is confirmed. */
  readonly probeWindowMs: number;
  /**
   * How far back the commit walk may go looking for the running version. A deployment further
   * behind than this is refused rather than fetched unboundedly — the commit graph comes from the
   * remote, so every walk over it needs a bound.
   */
  readonly maxAncestryDepth: number;
}

export const DEFAULT_REPO_URL = 'https://github.com/jamie-lord/cutiemail.git';

const DAY_MS = 86_400_000;

/** Whether `host` is a loopback address. Mirrors main.ts; kept local so the modules stay unrelated. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
}

/**
 * Validate the remote URL.
 *
 * HTTPS is the entire trust root (ADR 0025): there is no signature to fall back on, so a plaintext
 * fetch would let anyone on the path choose the code this machine runs. Loopback `http://` is
 * allowed so the protocol client can be exercised against a real local server in tests — a carve-out
 * that is safe for the same reason the daemon's dev certificate is loopback-only, and one that
 * cannot be reached accidentally in production because no deployment points at its own machine.
 */
export function parseRepoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpdateConfigError(`MAIL_UPDATE_REPO is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.href;
  throw new UpdateConfigError(
    `MAIL_UPDATE_REPO must be an https:// URL, got ${JSON.stringify(raw)}. TLS to the remote is the whole trust root — ` +
      'there is no release signature behind it, so a plaintext fetch would let anyone on the network path choose the code this machine runs.',
  );
}

/**
 * A branch name safe to put in a `ref-prefix` and to compare against what comes back.
 *
 * Refused shapes are git's own (`git check-ref-format`) plus the ones that matter to us: a name with
 * a space or a NUL would break the pkt-line request framing, and `..` would let a crafted value
 * address a different ref namespace.
 */
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  // Space, git's forbidden punctuation, and every control character including NUL and DEL.
  if (/[ ~^:?*[\\]/.test(name)) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Parse a positive-integer env var, failing loud rather than silently defaulting. */
function positiveEnv(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UpdateConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Same, but zero is meaningful (keep no old versions; require no bake time). */
function nonNegativeEnv(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new UpdateConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function updateConfigFromEnv(env: Record<string, string | undefined>): UpdateConfig {
  const rawMode = env.MAIL_UPDATE_MODE;
  let mode: UpdateMode;
  if (rawMode === undefined || rawMode === '') mode = 'check';
  else if (rawMode === 'off' || rawMode === 'check' || rawMode === 'apply') mode = rawMode;
  else {
    // The one setting where guessing a default inverts a safety property in BOTH directions:
    // guessing 'off' silently disables updates the operator asked for, guessing 'apply' hands an
    // unattended process the keys they did not. Same stance as MAIL_OUTBOUND.
    throw new UpdateConfigError(
      `MAIL_UPDATE_MODE must be "off", "check" or "apply", got ${JSON.stringify(rawMode)}: refusing to guess.`,
    );
  }

  const branch = env.MAIL_UPDATE_BRANCH ?? 'main';
  if (!validBranchName(branch)) {
    throw new UpdateConfigError(`MAIL_UPDATE_BRANCH is not a valid ref name: ${JSON.stringify(branch)}`);
  }

  return {
    repoUrl: parseRepoUrl(env.MAIL_UPDATE_REPO ?? DEFAULT_REPO_URL),
    branch,
    root: env.MAIL_UPDATE_ROOT ?? 'update-store',
    mode,
    bakeMs: nonNegativeEnv(env.MAIL_UPDATE_BAKE_DAYS, 'MAIL_UPDATE_BAKE_DAYS', 3) * DAY_MS,
    staleMs: positiveEnv(env.MAIL_UPDATE_STALE_DAYS, 'MAIL_UPDATE_STALE_DAYS', 30) * DAY_MS,
    keepVersions: nonNegativeEnv(env.MAIL_UPDATE_KEEP, 'MAIL_UPDATE_KEEP', 3),
    drainDeadlineMs: positiveEnv(env.MAIL_UPDATE_DRAIN_SECONDS, 'MAIL_UPDATE_DRAIN_SECONDS', 120) * 1000,
    probeWindowMs: positiveEnv(env.MAIL_UPDATE_PROBE_SECONDS, 'MAIL_UPDATE_PROBE_SECONDS', 300) * 1000,
    maxAncestryDepth: positiveEnv(env.MAIL_UPDATE_MAX_DEPTH, 'MAIL_UPDATE_MAX_DEPTH', 2000),
  };
}
