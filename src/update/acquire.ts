/**
 * Acquiring a candidate: from "what does the branch point at" to "a verified checkout on disk".
 *
 * This is rungs 1 and 2 of the ladder in ADR 0025 — provenance and integrity — and it is the last
 * point at which the remote has any influence. Everything after this operates on files whose bytes
 * hashed to the ids we asked for and whose names passed the checkout's allow-list.
 *
 * The two provenance rules, both enforced here and both local:
 *
 *   descendant-only  The candidate must have the commit we are running in its ancestry. Nobody can
 *                    move a deployment backwards, and a force-push that rewrites deployed history
 *                    refuses rather than silently applying. Fix-forward is the only path that
 *                    reaches a deployment, which is the right discipline anyway.
 *   bake time        The commit must be at least `bakeMs` old, so a mistake merged to the branch has
 *                    a window to be noticed and reverted before it reaches anyone.
 *
 * What bake time is and is not: it is a guard against MISTAKES, not against an attacker. The
 * timestamp comes from the commit, so anyone who can push to the branch can backdate it. They can
 * also just push, which is the larger problem, and the answer to that one is the repository's own
 * access control (ADR 0025 says so plainly rather than pretending a signature would help).
 *
 * A candidate is left STAGED, not promoted. Promotion means "this is a version", and a version has
 * not earned that until the pre-flight harness has run against it. A failed check therefore leaves
 * nothing behind in `versions/` at all.
 */

import { decodePackfile, DEFAULT_PACK_LIMITS } from './packfile.ts';
import { ancestryFrom, parseCommit, type Commit, type GitObject } from './objects.ts';
import { checkoutTree } from './checkout.ts';
import type { GitRemote } from './smart-http.ts';
import type { VersionStore } from './version-store.ts';

export class AcquireError extends Error {}

/**
 * How far back the first fetch reaches.
 *
 * Fetching 50 commits instead of 1 costs almost nothing: consecutive commits share their trees and
 * blobs, so the extra history is a handful of small deltas on top of a snapshot we were fetching
 * anyway. Starting deep enough to cover any realistic gap avoids a second round trip in the common
 * case, and the escalation below covers a deployment that has been left alone for longer.
 */
export const INITIAL_DEPTH = 50;
const DEPTH_MULTIPLIER = 8;
const MAX_FETCH_ATTEMPTS = 4;

/**
 * How many commits the ancestry walk may visit.
 *
 * Deliberately far above the fetch depth, and not the same number. Shallow depth counts
 * GENERATIONS, so a history with merges can hand back many more commits than the depth asked for,
 * and tying the walk to the depth would refuse ordinary repositories. This bound exists for a
 * different reason — a fabricated graph, a cycle, an invented fan-out — and only needs to be
 * finite.
 */
function ancestryWalkBound(maxDepth: number): number {
  return Math.max(10_000, maxDepth * 4);
}

export interface AcquireDeps {
  readonly remote: GitRemote;
  readonly store: VersionStore;
  readonly branch: string;
  readonly bakeMs: number;
  readonly maxAncestryDepth: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** A staged, verified checkout that has passed provenance and integrity. */
export interface Candidate {
  readonly sha: string;
  /** Committer timestamp in milliseconds. */
  readonly committedAt: number;
  /** Where the checkout was written. Under `staging/`, not yet a version. */
  readonly path: string;
  readonly files: number;
  /** The commit we are running, which this one descends from. Null only when adopting. */
  readonly from: string | null;
}

export type AcquireOutcome =
  /** The branch tip is already what we run. */
  | { readonly kind: 'up-to-date'; readonly sha: string }
  /** A newer commit exists but has not sat long enough yet. */
  | { readonly kind: 'not-yet-baked'; readonly sha: string; readonly ageMs: number; readonly requiredMs: number }
  /** A newer commit exists and we will not take it. The reason is for an operator, not a retry. */
  | { readonly kind: 'refused'; readonly sha: string; readonly reason: string }
  | { readonly kind: 'candidate'; readonly candidate: Candidate };

/** Look up the branch tip, refusing anything that is not exactly the one ref we asked about. */
async function resolveBranchTip(remote: GitRemote, branch: string): Promise<string> {
  const wanted = `refs/heads/${branch}`;
  const refs = await remote.lsRefs([wanted]);
  const tip = refs.get(wanted);
  if (tip === undefined) {
    const seen = [...refs.keys()];
    throw new AcquireError(
      `the remote has no ${wanted}${seen.length > 0 ? ` (it offered ${seen.join(', ')})` : ''}. Check MAIL_UPDATE_BRANCH and MAIL_UPDATE_REPO.`,
    );
  }
  return tip;
}

/** Index a decoded pack by id, with a commit-typed view for the ancestry walk. */
function commitReader(objects: ReadonlyMap<string, GitObject>): (id: string) => Commit | undefined {
  const cache = new Map<string, Commit>();
  return (id) => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const obj = objects.get(id);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    const parsed = parseCommit(obj.data);
    cache.set(id, parsed);
    return parsed;
  };
}

/**
 * Fetch until the running commit is visible in the candidate's ancestry, or until we can say for
 * certain that it is not there.
 *
 * The distinction is the point of the loop. A walk that ran out of history AT A SHALLOW BOUNDARY
 * proves nothing — the running commit may be one commit further back — so we fetch deeper. A walk
 * that reached the end of what the remote sent WITHOUT touching a boundary has seen the candidate's
 * whole history, and the running commit is genuinely not in it: that is a force-push, or a
 * different repository, and the answer is to refuse rather than to keep pulling.
 */
async function fetchUntilAncestryDecided(
  deps: AcquireDeps,
  tip: string,
  current: string,
): Promise<{ objects: Map<string, GitObject>; descends: boolean; exhausted: boolean; depth: number }> {
  let depth = Math.min(INITIAL_DEPTH, deps.maxAncestryDepth);
  for (let attempt = 1; ; attempt++) {
    const { pack, shallow } = await deps.remote.fetchPack(tip, depth);
    deps.log?.(`fetched ${pack.length} bytes at depth ${depth} (${shallow.length} shallow boundary commit(s))`);
    const objects = decodePackfile(pack, DEFAULT_PACK_LIMITS);

    const walked = ancestryFrom(tip, commitReader(objects), ancestryWalkBound(deps.maxAncestryDepth));
    if (walked.has(current)) return { objects, descends: true, exhausted: false, depth };

    // Did the walk stop because history was cut, or because there is no more history?
    const boundary = new Set(shallow);
    const hitBoundary = [...walked].some((id) => boundary.has(id));
    const canGoDeeper = depth < deps.maxAncestryDepth && attempt < MAX_FETCH_ATTEMPTS;
    if (!hitBoundary || !canGoDeeper) {
      return { objects, descends: false, exhausted: !hitBoundary, depth };
    }
    depth = Math.min(depth * DEPTH_MULTIPLIER, deps.maxAncestryDepth);
  }
}

/** Write the tree of `sha` into the store's staging area. */
function stageCheckout(store: VersionStore, sha: string, objects: ReadonlyMap<string, GitObject>): { path: string; files: number } {
  const commitObj = objects.get(sha);
  if (commitObj === undefined || commitObj.type !== 'commit') {
    throw new AcquireError(`the pack did not contain commit ${sha}, which is what we asked for`);
  }
  const commit = parseCommit(commitObj.data);
  const path = store.stagingPath(sha);
  const files = checkoutTree(commit.tree, path, (id) => objects.get(id));
  return { path, files };
}

/**
 * Find and stage the next version, applying both provenance rules.
 *
 * Returns an outcome rather than throwing for the ordinary "no" answers, because "the commit is
 * four hours old" and "the network is down" are different events: the first is the mechanism
 * working, and reporting it as an error would train an operator to ignore the alerts that matter.
 */
export async function acquireCandidate(deps: AcquireDeps): Promise<AcquireOutcome> {
  const now = deps.now ?? Date.now;
  deps.store.ensure();
  deps.store.clearStaging();

  const current = deps.store.currentSha();
  const tip = await resolveBranchTip(deps.remote, deps.branch);
  if (current !== null && tip === current) return { kind: 'up-to-date', sha: tip };
  if (current === null) {
    return {
      kind: 'refused',
      sha: tip,
      reason:
        'the version store has no current version, so there is nothing for the candidate to descend from. ' +
        'Record what this deployment is running first: `node src/update/main.ts adopt <commit>`.',
    };
  }
  const { objects, descends, exhausted, depth } = await fetchUntilAncestryDecided(deps, tip, current);
  if (!descends) {
    return {
      kind: 'refused',
      sha: tip,
      reason: exhausted
        ? `${tip} does not have ${current} in its ancestry: the branch has been rewritten, or this deployment is running something that was never on it. ` +
          'Refusing, because applying it would move this machine onto a history that does not contain what it is running. Fix forward with a new commit.'
        : `could not find ${current} within ${depth} commits of ${tip}. This deployment is a long way behind; update it by hand, then re-adopt.`,
    };
  }

  const commitObj = objects.get(tip);
  if (commitObj === undefined || commitObj.type !== 'commit') {
    throw new AcquireError(`the pack did not contain commit ${tip}, which is what we asked for`);
  }
  const committedAt = parseCommit(commitObj.data).committedAt * 1000;
  const ageMs = now() - committedAt;
  if (ageMs < deps.bakeMs) {
    return { kind: 'not-yet-baked', sha: tip, ageMs, requiredMs: deps.bakeMs };
  }

  const { path, files } = stageCheckout(deps.store, tip, objects);
  deps.log?.(`staged ${files} file(s) of ${tip} at ${path}`);
  return { kind: 'candidate', candidate: { sha: tip, committedAt, path, files, from: current } };
}

/**
 * Materialise one named commit and make it current, without any provenance rule.
 *
 * This is adoption: telling the store what this deployment is already running, so that every later
 * update has something to descend from. It deliberately fetches the tree from the remote rather
 * than copying whatever is in the install directory — the store must contain only content-verified
 * checkouts, and taking the operator's word for the sha while copying local files would let a
 * locally-modified tree become the baseline that everything after it is compared against.
 *
 * It also validates the claim as a side effect: a sha that is not in the repository cannot be
 * fetched, so a typo fails here rather than silently poisoning the descendant check forever.
 */
export async function adoptVersion(deps: AcquireDeps, sha: string): Promise<{ sha: string; path: string; files: number }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new AcquireError(`adopt: ${JSON.stringify(sha)} is not a full 40-character commit id. Abbreviations are ambiguous; use \`git rev-parse HEAD\`.`);
  }
  deps.store.ensure();
  deps.store.clearStaging();
  const { pack } = await deps.remote.fetchPack(sha, 1);
  const objects = decodePackfile(pack, DEFAULT_PACK_LIMITS);
  const { path, files } = stageCheckout(deps.store, sha, objects);
  const promoted = deps.store.promote(sha);
  deps.store.switchTo(sha);
  // No log line here: the caller reports the outcome, and this said the same sentence again one
  // indent level in. Progress logging belongs to the steps that take time and can fail partway
  // (the fetch, the checkout); the summary belongs to whoever is talking to the operator.
  return { sha, path: promoted, files };
}
