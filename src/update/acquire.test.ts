/**
 * Provenance and integrity, driven end to end: a real server, a real packfile, a real checkout.
 *
 * The two rules under test are the only thing standing between "the remote said so" and "this
 * machine will run it", so each is exercised in both directions — it accepts what it should, and it
 * refuses what it must. A rule only ever shown to pass is not a rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCandidate, adoptVersion, INITIAL_DEPTH, type AcquireDeps } from './acquire.ts';
import { GitRemote } from './smart-http.ts';
import { VersionStore } from './version-store.ts';
import { RepoBuilder, startGitServer } from '../testing/git-repo.ts';

/** A fixed clock well after every commit below, so bake time passes unless a test says otherwise. */
const FIRST_COMMIT_AT = 1_700_000_000;
const DAY_MS = 86_400_000;

interface Harness {
  readonly deps: AcquireDeps;
  readonly store: VersionStore;
  readonly shas: string[];
  readonly server: Awaited<ReturnType<typeof startGitServer>>;
  readonly repo: RepoBuilder;
}

async function withHarness(
  opts: { commits: number; now?: number; bakeMs?: number; maxAncestryDepth?: number },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-acquire-'));
  const repo = new RepoBuilder();
  const shas = repo.linear(opts.commits, { firstCommittedAt: FIRST_COMMIT_AT });
  const server = await startGitServer({ objects: repo.objects, refs: { 'refs/heads/main': shas[shas.length - 1]! } });
  try {
    const store = new VersionStore(join(dir, 'store'));
    const now = opts.now ?? (FIRST_COMMIT_AT + opts.commits * 3600) * 1000 + 30 * DAY_MS;
    const deps: AcquireDeps = {
      remote: new GitRemote(server.url, { timeoutMs: 5000 }),
      store,
      branch: 'main',
      bakeMs: opts.bakeMs ?? 3 * DAY_MS,
      maxAncestryDepth: opts.maxAncestryDepth ?? 2000,
      now: () => now,
    };
    await fn({ deps, store, shas, server, repo });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('adopting records what is running, fetched from the remote rather than copied from disk', async () => {
  await withHarness({ commits: 3 }, async ({ deps, store, shas }) => {
    const adopted = await adoptVersion(deps, shas[1]!);
    assert.equal(adopted.sha, shas[1]);
    assert.equal(store.currentSha(), shas[1]);
    // The checkout is the tree of THAT commit, not of the branch tip: two files, not three.
    assert.deepEqual(readdirSync(store.pathFor(shas[1]!)).sort(), ['f0.ts', 'f1.ts']);
    assert.equal(readFileSync(join(store.pathFor(shas[1]!), 'f1.ts'), 'utf8'), 'export const v1 = 1;\n');
  });
});

test('an abbreviated commit id is refused: it is ambiguous, and this is the baseline everything else is compared against', async () => {
  await withHarness({ commits: 2 }, async ({ deps, shas }) => {
    await assert.rejects(() => adoptVersion(deps, shas[0]!.slice(0, 8)), /not a full 40-character commit id/);
  });
});

test('a descendant of what we run is staged, and reports what it descends from', async () => {
  await withHarness({ commits: 4 }, async ({ deps, store, shas }) => {
    await adoptVersion(deps, shas[1]!);
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'candidate');
    if (outcome.kind !== 'candidate') return;
    assert.equal(outcome.candidate.sha, shas[3]);
    assert.equal(outcome.candidate.from, shas[1]);
    assert.equal(outcome.candidate.files, 4);
    // STAGED, not promoted: a candidate has not earned the name "version" until the pre-flight
    // harness has run against it, so nothing new appears under versions/ yet.
    assert.equal(existsSync(outcome.candidate.path), true);
    assert.equal(store.has(shas[3]!), false, 'the candidate is not a version yet');
    assert.equal(store.currentSha(), shas[1], 'and what runs has not changed');
  });
});

test('the branch tip we already run is up to date, with no fetch at all', async () => {
  await withHarness({ commits: 2 }, async ({ deps, shas, server }) => {
    await adoptVersion(deps, shas[1]!);
    const before = server.commands.length;
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'up-to-date');
    // One ls-refs and nothing else: there is no reason to pull a pack to learn we are current.
    assert.deepEqual(server.commands.slice(before).map((c) => c.name), ['ls-refs']);
  });
});

test('a commit that has not baked long enough is declined, and nothing is staged', async () => {
  // The tip is one hour old; the rule asks for three days.
  const tipAt = (FIRST_COMMIT_AT + 2 * 3600) * 1000;
  await withHarness({ commits: 3, now: tipAt + 3600_000 }, async ({ deps, store, shas }) => {
    await adoptVersion(deps, shas[0]!);
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'not-yet-baked');
    if (outcome.kind !== 'not-yet-baked') return;
    assert.equal(outcome.sha, shas[2]);
    assert.equal(outcome.ageMs, 3600_000);
    assert.equal(outcome.requiredMs, 3 * DAY_MS);
    assert.equal(existsSync(join(store.root, 'staging', shas[2]!)), false, 'a declined commit leaves nothing behind');
  });

  // The negative control for the rule itself: the SAME commit, one second past the window.
  await withHarness({ commits: 3, now: tipAt + 3 * DAY_MS }, async ({ deps, shas }) => {
    await adoptVersion(deps, shas[0]!);
    assert.equal((await acquireCandidate(deps)).kind, 'candidate');
  });
});

test('a rewritten branch is refused: the running commit is not in the candidate history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-acquire-rewrite-'));
  const repo = new RepoBuilder();
  // Two disjoint histories in one object store — exactly what a force-push leaves behind.
  const deployed = repo.linear(2, { firstCommittedAt: FIRST_COMMIT_AT });
  const rewrittenTree = repo.tree([{ mode: '100644', name: 'other.ts', id: repo.blob('export const other = 1;\n') }]);
  const rewritten = repo.commit({ tree: rewrittenTree, committedAt: FIRST_COMMIT_AT + 10 });
  const server = await startGitServer({ objects: repo.objects, refs: { 'refs/heads/main': deployed[1]! } });
  try {
    const store = new VersionStore(join(dir, 'store'));
    const deps: AcquireDeps = {
      remote: new GitRemote(server.url, { timeoutMs: 5000 }),
      store,
      branch: 'main',
      bakeMs: 0,
      maxAncestryDepth: 2000,
      now: () => (FIRST_COMMIT_AT + 10_000) * 1000,
    };
    await adoptVersion(deps, deployed[1]!);
    // Now the branch is force-pushed onto the unrelated commit.
    await server.close();
    const server2 = await startGitServer({ objects: repo.objects, refs: { 'refs/heads/main': rewritten } });
    try {
      const deps2: AcquireDeps = { ...deps, remote: new GitRemote(server2.url, { timeoutMs: 5000 }) };
      const outcome = await acquireCandidate(deps2);
      assert.equal(outcome.kind, 'refused');
      if (outcome.kind !== 'refused') return;
      assert.match(outcome.reason, /does not have .* in its ancestry/);
      assert.match(outcome.reason, /Fix forward/);
      assert.equal(store.currentSha(), deployed[1], 'the running version is untouched');
      assert.equal(store.has(rewritten), false);
    } finally {
      await server2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment further back than the first fetch reaches drives a deeper fetch, once', async () => {
  await withHarness({ commits: INITIAL_DEPTH + 10 }, async ({ deps, shas, server }) => {
    await adoptVersion(deps, shas[0]!);
    const before = server.commands.length;
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'candidate');
    const fetches = server.commands.slice(before).filter((c) => c.name === 'fetch');
    assert.equal(fetches.length, 2, 'the first depth missed, the second found it');
    assert.deepEqual(
      fetches.map((f) => f.args.find((a) => a.startsWith('deepen '))),
      [`deepen ${INITIAL_DEPTH}`, `deepen ${INITIAL_DEPTH * 8}`],
    );
  });
});

test('a deployment beyond the depth bound is refused with a different reason than a rewrite', async () => {
  await withHarness({ commits: 40, maxAncestryDepth: 10 }, async ({ deps, shas, server }) => {
    await adoptVersion(deps, shas[0]!);
    const before = server.commands.length;
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind !== 'refused') return;
    // The distinction is the point: "we could not see that far" is a different event from "it is
    // not there", and only the second means the history was rewritten.
    assert.match(outcome.reason, /could not find .* within 10 commits/);
    assert.doesNotMatch(outcome.reason, /rewritten/);
    assert.equal(server.commands.slice(before).filter((c) => c.name === 'fetch').length, 1, 'and it stopped at the bound');
  });
});

test('an unadopted store refuses to apply anything, and says how to fix it', async () => {
  await withHarness({ commits: 2 }, async ({ deps }) => {
    const outcome = await acquireCandidate(deps);
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind !== 'refused') return;
    assert.match(outcome.reason, /adopt <commit>/);
  });
});

test('a hostile tree entry refuses the whole candidate and leaves no partial checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-acquire-hostile-'));
  const repo = new RepoBuilder();
  const base = repo.linear(1, { firstCommittedAt: FIRST_COMMIT_AT });
  // A descendant whose tree tries to write outside the checkout root.
  const evilTree = repo.tree([
    { mode: '100644', name: 'ok.ts', id: repo.blob('fine\n') },
    { mode: '100644', name: '../escaped.ts', id: repo.blob('pwned\n') },
  ]);
  const evil = repo.commit({ tree: evilTree, parents: [base[0]!], committedAt: FIRST_COMMIT_AT + 3600 });
  const server = await startGitServer({ objects: repo.objects, refs: { 'refs/heads/main': base[0]! } });
  try {
    const store = new VersionStore(join(dir, 'store'));
    const deps: AcquireDeps = {
      remote: new GitRemote(server.url, { timeoutMs: 5000 }),
      store,
      branch: 'main',
      bakeMs: 0,
      maxAncestryDepth: 2000,
      now: () => (FIRST_COMMIT_AT + 100_000) * 1000,
    };
    await adoptVersion(deps, base[0]!);
    await server.close();
    const server2 = await startGitServer({ objects: repo.objects, refs: { 'refs/heads/main': evil } });
    try {
      const deps2: AcquireDeps = { ...deps, remote: new GitRemote(server2.url, { timeoutMs: 5000 }) };
      await assert.rejects(() => acquireCandidate(deps2), /refusing tree entry name/);
      assert.equal(existsSync(join(store.root, 'staging', evil)), false, 'no partial tree survives');
      assert.equal(existsSync(join(store.root, 'staging', 'escaped.ts')), false);
      assert.equal(store.currentSha(), base[0], 'and what runs is untouched');
    } finally {
      await server2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
