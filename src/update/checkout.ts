/**
 * Writing a git tree to disk, safely.
 *
 * This is the sharp end of the updater. Every other module reads bytes; this one creates files
 * from names a remote chose, which is the combination behind a long line of real CVEs in real git
 * implementations. The rules below are deliberately strict and deliberately *allow-list* shaped:
 * anything not understood is a refusal, never a skip, because skipping produces a checkout that
 * looks complete and is not.
 *
 * What a hostile tree tries:
 *
 *   ../../etc/cron.d/x      escape the staging root by traversal
 *   /etc/passwd             escape by absolute path
 *   .git/hooks/post-checkout  land code git itself will execute later
 *   .GIT, .Git              the same, past a case-sensitive check, on a case-insensitive volume
 *   name\0extra             truncate differently in different layers
 *   a/b                     a separator inside what must be a single path component
 *   mode 120000             a symlink to `/`, so the NEXT entry writes through it
 *   mode 160000             a gitlink (submodule), which we neither have nor want
 *
 * The last is worth spelling out: a symlink entry is not dangerous by itself, it is dangerous
 * because a later entry writes *through* it, escaping a root that every individual path check
 * passed. Refusing the mode outright is the only defence that does not depend on ordering.
 */

import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseTree, type GitObject } from './objects.ts';

export class CheckoutError extends Error {}

export interface CheckoutLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_CHECKOUT_LIMITS: CheckoutLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDepth: 32,
};

/** Regular file, executable file, directory. Everything else is refused. */
const MODE_FILE = '100644';
const MODE_EXEC = '100755';
const MODE_DIR = '40000';

/**
 * Is this safe as a single path component inside the staging root?
 *
 * Exported so the negative controls can exercise it directly as well as through a whole checkout.
 */
export function isSafeComponent(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('\0')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // `.git` in any case: on a case-insensitive volume `.GIT/hooks/pre-commit` is `.git/...`, and
  // any later git operation in that tree would execute it.
  if (name.toLowerCase() === '.git') return false;
  // Trailing dots and spaces are stripped by some filesystems, so `foo.` and `foo` can collide.
  if (/[. ]$/.test(name)) return false;
  return true;
}

/**
 * Materialise `treeId` under `root`, which must not already exist.
 *
 * Returns the number of files written. Throws on anything unexpected; the caller treats that as
 * "no update available" and removes the partial directory.
 */
export function checkoutTree(
  treeId: string,
  root: string,
  objectOf: (id: string) => GitObject | undefined,
  limits: CheckoutLimits = DEFAULT_CHECKOUT_LIMITS,
): number {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Resolve the root through any symlinks ONCE, so the containment assertion below compares
  // real paths. Without this a symlinked staging directory defeats the prefix check.
  const realRoot = realpathSync(root);
  let files = 0;
  let bytes = 0;

  const walk = (id: string, dir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new CheckoutError(`tree nests deeper than ${limits.maxDepth}`);
    const obj = objectOf(id);
    if (obj === undefined) throw new CheckoutError(`tree ${id} is missing from the pack`);
    if (obj.type !== 'tree') throw new CheckoutError(`object ${id} is a ${obj.type}, expected a tree`);

    for (const entry of parseTree(obj.data)) {
      if (!isSafeComponent(entry.name)) {
        throw new CheckoutError(`refusing tree entry name ${JSON.stringify(entry.name)}`);
      }
      const target = join(dir, entry.name);
      // Belt and braces: even with a validated component, assert the resulting path is inside the
      // root. Cheap, and it catches anything the component rules did not anticipate.
      const resolved = resolve(target);
      if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
        throw new CheckoutError(`refusing tree entry escaping the staging root: ${resolved}`);
      }

      if (entry.mode === MODE_DIR) {
        mkdirSync(resolved, { mode: 0o700 });
        walk(entry.id, resolved, depth + 1);
        continue;
      }
      if (entry.mode !== MODE_FILE && entry.mode !== MODE_EXEC) {
        // 120000 symlink, 160000 gitlink, or anything else. This project has none of them, so a
        // tree that contains one is either not cutiemail or is trying something.
        throw new CheckoutError(`refusing tree entry ${JSON.stringify(entry.name)} with mode ${entry.mode}`);
      }

      const blob = objectOf(entry.id);
      if (blob === undefined) throw new CheckoutError(`blob ${entry.id} is missing from the pack`);
      if (blob.type !== 'blob') throw new CheckoutError(`object ${entry.id} is a ${blob.type}, expected a blob`);

      files += 1;
      bytes += blob.data.length;
      if (files > limits.maxFiles) throw new CheckoutError(`tree has more than ${limits.maxFiles} files`);
      if (bytes > limits.maxTotalBytes) throw new CheckoutError(`tree exceeds ${limits.maxTotalBytes} bytes`);

      // 'wx' so a name that somehow collides with something already written is an error rather
      // than a silent overwrite of a file we just verified.
      writeFileSync(resolved, blob.data, { mode: entry.mode === MODE_EXEC ? 0o700 : 0o600, flag: 'wx' });
    }
  };

  try {
    walk(treeId, realRoot, 0);
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return files;
}
