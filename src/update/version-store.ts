/**
 * The version store: where checkouts live and which one is running.
 *
 *   <root>/versions/<sha>/     a verified checkout, never modified after promotion
 *   <root>/staging/<sha>/      a checkout being written; promoted by rename, or removed
 *   <root>/current             a symlink to versions/<sha> — the ONE thing that says what runs
 *
 * The symlink is the whole switch. `systemd` starts `<root>/current/src/main.ts`, so a cutover is a
 * `rename(2)` over the link plus a restart, and a rollback is the same rename in reverse. Both are
 * atomic: a reader either sees the old target or the new one, never a partially-written path, and a
 * power cut mid-swap cannot leave a dangling `current`.
 *
 * PERMISSIONS. This directory holds the code the machine executes, so it must be writable by the
 * updater and by nobody else — emphatically not by the mail daemon, whose whole reason for being a
 * separate program (ADR 0025) is that a remote compromise of it must not become persistent. The
 * store checks that on every open rather than trusting the deployment script to have got it right;
 * a `chown -R mail:mail` over the install directory is an easy and silent mistake to make.
 *
 * Contrast with the databases: those are 0600 secrets. These are 0755 public code — the mail user
 * has to be able to READ what it runs.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export class VersionStoreError extends Error {}

/** A commit id, exactly as git writes it. Anything else must never reach a path. */
export function isCommitSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/**
 * Assert `sha` is safe to use as a path component.
 *
 * The version store's directory names come from a remote's ref advertisement, which makes this the
 * same class of problem as the checkout's tree-entry names: a value like `../../etc` reaching
 * `join()` is a path traversal. The allow-list is total — 40 lowercase hex digits, nothing else —
 * so there is no cleverness to get wrong.
 */
function requireSha(sha: string): string {
  if (!isCommitSha(sha)) {
    throw new VersionStoreError(`not a commit id: ${JSON.stringify(sha)} (40 lowercase hex digits)`);
  }
  return sha;
}

/**
 * Widen a promoted checkout to world-readable, preserving the executable bit.
 *
 * Iterative rather than recursive: the depth is already bounded by the checkout, but a plain loop
 * has no stack to overflow and reads no worse.
 */
function makeReadable(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const st = lstatSync(path);
    if (st.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) stack.push(join(path, name));
    } else {
      chmodSync(path, (st.mode & 0o100) !== 0 ? 0o755 : 0o644);
    }
  }
}

export interface VersionInfo {
  readonly sha: string;
  readonly path: string;
  /** When the checkout was written here, not when the commit was authored. */
  readonly installedAt: number;
  readonly current: boolean;
}

export class VersionStore {
  readonly root: string;
  readonly #versionsDir: string;
  readonly #stagingDir: string;
  readonly #currentLink: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.#versionsDir = join(this.root, 'versions');
    this.#stagingDir = join(this.root, 'staging');
    this.#currentLink = join(this.root, 'current');
  }

  /** Create the layout if it is missing, and refuse a store anyone else can write to. */
  ensure(): void {
    for (const dir of [this.root, this.#versionsDir, this.#stagingDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    this.assertNotSharedWritable();
  }

  /**
   * Refuse to operate on a store that group or others can write.
   *
   * Anyone who can write here chooses the code this machine runs on its next restart, which is a
   * strictly larger privilege than anything the mail daemon itself holds. The daemon is deliberately
   * sandboxed and deliberately cannot write its own source; a group-writable version store hands
   * that back. Checked on every open because the hazard is a later `chown`/`chmod`, not a wrong
   * initial mkdir.
   */
  assertNotSharedWritable(): void {
    const mode = statSync(this.root).mode & 0o777;
    if ((mode & 0o022) !== 0) {
      throw new VersionStoreError(
        `${this.root} is mode ${mode.toString(8).padStart(4, '0')}: group- or world-writable. Anyone who can write here chooses the code this machine runs. ` +
          `Fix with \`chmod go-w ${this.root}\`, and check that the mail daemon's user does NOT own it.`,
      );
    }
  }

  pathFor(sha: string): string {
    return join(this.#versionsDir, requireSha(sha));
  }

  has(sha: string): boolean {
    return existsSync(this.pathFor(sha));
  }

  get currentLink(): string {
    return this.#currentLink;
  }

  /**
   * Which version is current, or null when the store has not been adopted yet.
   *
   * Reads the symlink rather than a recorded value, so the answer is what will actually start.
   * A `current` pointing at a version that is not in the store is corruption, not a state to
   * paper over: say so rather than returning a sha nothing can run.
   */
  currentSha(): string | null {
    let target: string;
    try {
      target = readlinkSync(this.#currentLink);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((e as NodeJS.ErrnoException).code === 'EINVAL') {
        throw new VersionStoreError(`${this.#currentLink} is not a symlink. The version store expects it to point at versions/<sha>.`);
      }
      throw e;
    }
    const sha = basename(target);
    if (!isCommitSha(sha)) {
      throw new VersionStoreError(`${this.#currentLink} points at ${JSON.stringify(target)}, whose last component is not a commit id.`);
    }
    if (!this.has(sha)) {
      throw new VersionStoreError(`${this.#currentLink} points at version ${sha}, which is not in ${this.#versionsDir}.`);
    }
    return sha;
  }

  /**
   * A clean staging directory for `sha`, removing any leftover from an interrupted run.
   *
   * Staging is separate from `versions/` so a half-written checkout is never visible under a name
   * the rest of the system treats as verified — `has()` answering true for a truncated tree is
   * exactly the kind of "looks complete and is not" the checkout rules exist to prevent.
   */
  stagingPath(sha: string): string {
    const path = join(this.#stagingDir, requireSha(sha));
    rmSync(path, { recursive: true, force: true });
    return path;
  }

  /** Move a completed staging checkout into `versions/`. Refuses to overwrite an existing version. */
  promote(sha: string): string {
    const from = join(this.#stagingDir, requireSha(sha));
    const to = this.pathFor(sha);
    if (!existsSync(from)) throw new VersionStoreError(`nothing staged at ${from}`);
    if (existsSync(to)) {
      // A version directory is named by the hash of its content, so an existing one is either
      // identical or evidence that something outside this store has been editing it. Neither is a
      // reason to overwrite: drop the staged copy and keep what is already trusted.
      rmSync(from, { recursive: true, force: true });
      return to;
    }
    renameSync(from, to);
    // The checkout writes privately (0600/0700) because a tree being assembled from remote bytes has
    // no business being readable until it is verified. A PROMOTED version is the opposite: it is the
    // code the mail user has to be able to read and execute, and it is public source in any case.
    // Widen it here, in one place, rather than loosening the checkout's defaults.
    makeReadable(to);
    return to;
  }

  /**
   * Point `current` at `sha`, atomically.
   *
   * `symlink` then `rename` rather than `unlink` then `symlink`: the latter has a window in which
   * `current` does not exist at all, and a restart landing in that window fails to start the mail
   * server with no obvious cause. `rename(2)` over an existing symlink has no such window.
   *
   * The target is stored RELATIVE (`versions/<sha>`), so the whole store can be moved or bind-mounted
   * without every link inside it dangling.
   */
  switchTo(sha: string): void {
    requireSha(sha);
    if (!this.has(sha)) throw new VersionStoreError(`cannot switch to ${sha}: it is not in ${this.#versionsDir}`);
    const tmp = join(this.root, `.current.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    symlinkSync(join('versions', sha), tmp);
    renameSync(tmp, this.#currentLink);
  }

  /** Every version present, newest first. */
  list(): VersionInfo[] {
    if (!existsSync(this.#versionsDir)) return [];
    const current = (() => {
      try {
        return this.currentSha();
      } catch {
        return null; // a broken `current` must not stop us listing what is on disk
      }
    })();
    const out: VersionInfo[] = [];
    for (const name of readdirSync(this.#versionsDir)) {
      if (!isCommitSha(name)) continue; // ignore anything we did not put here
      const path = join(this.#versionsDir, name);
      let installedAt = 0;
      try {
        installedAt = lstatSync(path).mtimeMs;
      } catch {
        continue;
      }
      out.push({ sha: name, path, installedAt, current: name === current });
    }
    return out.sort((a, b) => b.installedAt - a.installedAt);
  }

  /**
   * Keep the current version, anything named in `protect`, and the `keep` newest of what remains.
   *
   * The current version is protected unconditionally and does not count against `keep` — pruning
   * what is running would delete the source of a live process, and on the next restart there would
   * be nothing to start. Returns what was removed so the caller can report it rather than deleting
   * code silently.
   */
  prune(keep: number, protect: readonly string[] = []): string[] {
    const keepSet = new Set(protect.filter(isCommitSha));
    const versions = this.list();
    for (const v of versions) if (v.current) keepSet.add(v.sha);
    const removed: string[] = [];
    let kept = 0;
    for (const v of versions) {
      if (keepSet.has(v.sha)) continue;
      if (kept < keep) {
        kept++;
        continue;
      }
      rmSync(v.path, { recursive: true, force: true });
      removed.push(v.sha);
    }
    return removed;
  }

  /** Remove every staged checkout. Called at the start of a run to clear an interrupted one. */
  clearStaging(): void {
    if (!existsSync(this.#stagingDir)) return;
    for (const name of readdirSync(this.#stagingDir)) {
      rmSync(join(this.#stagingDir, name), { recursive: true, force: true });
    }
  }
}
