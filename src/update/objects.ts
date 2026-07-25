/**
 * Git's object model, only as much of it as an updater needs: verify a SHA, read a commit's
 * parents, and walk a tree.
 *
 * Object identity is `sha1("<type> <size>\0" + content)`. Verifying it gives integrity of the
 * transfer for free — the objects either hash to the SHA we asked for or they do not. It is NOT a
 * security boundary: git still defaults to SHA-1 and Node's `createHash` has no collision
 * detection, so the trust root remains TLS to the host we fetched from (ADR 0025).
 */

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export class GitObjectError extends Error {}

/** The object id of `data` as an object of `type`. */
export function objectId(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'latin1').update(data).digest('hex');
}

/** A parsed commit. Everything else in the header is ignored — we need ancestry and a tree. */
export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  /** Committer timestamp, seconds since the epoch. Used for the bake-time rule. */
  readonly committedAt: number;
}

export function parseCommit(data: Buffer): Commit {
  // The header is line-oriented ASCII up to the first blank line; the message follows.
  const text = data.toString('latin1');
  const end = text.indexOf('\n\n');
  const header = end === -1 ? text : text.slice(0, end);
  let tree: string | null = null;
  const parents: string[] = [];
  let committedAt = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      // "committer Name <email> 1753380000 +0100" — the timestamp is the second-to-last field.
      const parts = line.trim().split(' ');
      const ts = Number(parts[parts.length - 2]);
      if (Number.isFinite(ts)) committedAt = ts;
    }
  }
  if (tree === null || !/^[0-9a-f]{40}$/.test(tree)) throw new GitObjectError('commit has no valid tree');
  for (const p of parents) if (!/^[0-9a-f]{40}$/.test(p)) throw new GitObjectError(`commit has a malformed parent ${p}`);
  return { tree, parents, committedAt };
}

/** One entry in a tree. `mode` is octal as written by git. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly id: string;
}

/**
 * Parse a tree object: repeated `<mode> <name>\0<20 raw bytes of sha>`.
 *
 * Names are returned exactly as stored, including anything hostile — validating them is the
 * checkout's job, and doing it here would leave a second, laxer parser for someone to find later.
 */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) throw new GitObjectError('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space);
    if (nul === -1) throw new GitObjectError('tree entry has no name terminator');
    // Twenty raw bytes of object id must follow the terminator.
    if (data.length - (nul + 1) < 20) throw new GitObjectError('tree entry is truncated before its object id');
    const mode = data.subarray(off, space).toString('ascii');
    if (!/^[0-7]{5,6}$/.test(mode)) throw new GitObjectError(`tree entry has a malformed mode ${JSON.stringify(mode)}`);
    // latin1: a name is bytes. Decoding as UTF-8 would replace invalid sequences and silently
    // change what we are about to write to disk.
    const name = data.subarray(space + 1, nul).toString('latin1');
    const id = data.subarray(nul + 1, nul + 21).toString('hex');
    if (id.length !== 40) throw new GitObjectError('tree entry is truncated before its object id');
    out.push({ mode, name, id });
    off = nul + 21;
  }
  return out;
}

/**
 * Every commit reachable from `from`, bounded by `maxCommits`.
 *
 * An id is included even when its object is absent from `commitOf` — a shallow fetch cuts history
 * at a boundary, and the boundary commit still NAMES its parents even though they were not sent.
 * Including them is what lets the caller distinguish the two ways a descendant check can fail:
 * "this commit is genuinely not in our history" from "we did not fetch far enough back to see it".
 * The first is a refusal; the second is a reason to fetch deeper.
 *
 * The bound matters because the commit graph comes from the remote. Without it, a fabricated graph
 * — a cycle, or a fan-out of invented parents — walks forever.
 */
export function ancestryFrom(
  from: string,
  commitOf: (id: string) => Commit | undefined,
  maxCommits = 10_000,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    // Skip duplicates BEFORE testing the bound. The queue legitimately holds the same id twice —
    // any commit with two children reaches it by two paths — so counting queue entries rather than
    // distinct commits would refuse a perfectly ordinary merge-shaped history.
    if (seen.has(id)) continue;
    if (seen.size >= maxCommits) throw new GitObjectError(`ancestry walk exceeded ${maxCommits} commits`);
    seen.add(id);
    const c = commitOf(id);
    if (c === undefined) continue; // beyond the shallow boundary, or simply not sent
    for (const p of c.parents) if (!seen.has(p)) queue.push(p);
  }
  return seen;
}

/**
 * Is `target` an ancestor of `from` (or the same commit)?
 *
 * This is the descendant rule from ADR 0025: an update is only accepted when the commit we are
 * running is an ancestor of the candidate. That makes a rollback attack impossible and turns a
 * force-push over deployed history into a refusal rather than a silent downgrade.
 */
export function isAncestor(
  target: string,
  from: string,
  commitOf: (id: string) => Commit | undefined,
  maxCommits = 10_000,
): boolean {
  if (target === from) return true;
  return ancestryFrom(from, commitOf, maxCommits).has(target);
}
