/**
 * The version store, whose whole job is that exactly one thing says what runs and that swapping it
 * is atomic.
 *
 * The refusals matter more than the happy path. A directory name here comes from a remote's ref
 * advertisement, so it is the same class of input as a tree entry name; and a store that anyone else
 * can write to hands them the choice of what this machine executes on its next restart.
 */

import { test } from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionStore, VersionStoreError, isCommitSha } from './version-store.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function inTmp(fn: (store: VersionStore, base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'cutiemail-store-'));
  try {
    const store = new VersionStore(join(base, 'store'));
    store.ensure();
    fn(store, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Stage a trivial checkout for `sha` and promote it. */
function install(store: VersionStore, sha: string, opts: { exec?: boolean } = {}): string {
  const staged = store.stagingPath(sha);
  mkdirSync(join(staged, 'src'), { recursive: true, mode: 0o700 });
  writeFileSync(join(staged, 'src', 'main.ts'), `// ${sha}\n`, { mode: 0o600 });
  if (opts.exec === true) writeFileSync(join(staged, 'run.sh'), '#!/bin/sh\n', { mode: 0o700 });
  return store.promote(sha);
}

test('a promoted version becomes current through a relative symlink, and swapping is a rename', () => {
  inTmp((store) => {
    assert.equal(store.currentSha(), null, 'a fresh store has adopted nothing');
    install(store, SHA_A);
    store.switchTo(SHA_A);
    assert.equal(store.currentSha(), SHA_A);
    // Relative, so the whole store can be moved or bind-mounted without every link dangling.
    assert.equal(readlinkSync(store.currentLink), join('versions', SHA_A));

    install(store, SHA_B);
    store.switchTo(SHA_B);
    assert.equal(store.currentSha(), SHA_B);
    assert.equal(existsSync(store.pathFor(SHA_A)), true, 'the old version stays on disk for rollback');
  });
});

test('anything that is not a commit id is refused before it reaches a path', () => {
  assert.equal(isCommitSha(SHA_A), true);
  for (const bad of ['../../etc', '', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a/b', `${SHA_A}\0`, 'main']) {
    assert.equal(isCommitSha(bad), false, `${JSON.stringify(bad)} is not a commit id`);
    inTmp((store) => {
      assert.throws(() => store.pathFor(bad), VersionStoreError, `pathFor(${JSON.stringify(bad)})`);
      assert.throws(() => store.switchTo(bad), VersionStoreError, `switchTo(${JSON.stringify(bad)})`);
      assert.throws(() => store.stagingPath(bad), VersionStoreError, `stagingPath(${JSON.stringify(bad)})`);
    });
  }
});

test('a store anyone else can write to is refused, because writing here chooses what runs', () => {
  inTmp((store) => {
    chmodSync(store.root, 0o775);
    assert.throws(() => store.assertNotSharedWritable(), /group- or world-writable/);
    chmodSync(store.root, 0o757);
    assert.throws(() => store.assertNotSharedWritable(), /group- or world-writable/);
    // The negative control for the guard: 0755 is the mode a correct deployment has.
    chmodSync(store.root, 0o755);
    assert.doesNotThrow(() => store.assertNotSharedWritable());
  });
});

test('a current symlink pointing at nothing usable is corruption, not a state to work around', () => {
  inTmp((store) => {
    symlinkSync(join('versions', SHA_A), store.currentLink);
    assert.throws(() => store.currentSha(), /is not in/, 'points at a version that was never installed');
    rmSync(store.currentLink);
    symlinkSync('versions/not-a-sha', store.currentLink);
    assert.throws(() => store.currentSha(), /not a commit id/);
    rmSync(store.currentLink);
    writeFileSync(store.currentLink, 'a regular file\n');
    assert.throws(() => store.currentSha(), /is not a symlink/);
  });
});

test('switching to a version that is not installed is refused', () => {
  inTmp((store) => {
    assert.throws(() => store.switchTo(SHA_A), /not in/);
  });
});

test('a promoted version is world-readable, keeps its executable bits, and is never overwritten', () => {
  inTmp((store) => {
    const path = install(store, SHA_A, { exec: true });
    // The mail user has to be able to read and run this; the checkout writes it privately because a
    // tree assembled from remote bytes has no business being readable until it is verified.
    assert.equal(statSync(path).mode & 0o777, 0o755);
    assert.equal(statSync(join(path, 'src', 'main.ts')).mode & 0o777, 0o644);
    assert.equal(statSync(join(path, 'run.sh')).mode & 0o777, 0o755);

    // A version directory is named by the hash of its content, so a second promotion of the same id
    // is either identical or evidence something is editing the store. Neither warrants a rewrite.
    writeFileSync(join(path, 'marker'), 'original\n');
    const staged = store.stagingPath(SHA_A);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'marker'), 'replacement\n');
    store.promote(SHA_A);
    assert.equal(existsSync(join(store.root, 'staging', SHA_A)), false, 'the staged copy is dropped');
    assert.equal(existsSync(join(path, 'marker')), true, 'and the trusted one is left alone');
  });
});

test('pruning keeps what runs, what is protected, and the newest of the rest', () => {
  inTmp((store) => {
    for (const [i, sha] of [SHA_A, SHA_B, SHA_C].entries()) {
      const path = install(store, sha);
      // Distinct mtimes so "newest" is well defined without relying on filesystem granularity.
      const t = 1_700_000_000 + i * 100;
      utimesSync(path, t, t);
    }
    store.switchTo(SHA_A); // the OLDEST is current, so it must survive on that ground alone
    const removed = store.prune(1);
    assert.deepEqual(removed, [SHA_B], 'the newest non-current version is kept, the older one goes');
    assert.equal(store.has(SHA_A), true, 'never prune what is running');
    assert.equal(store.has(SHA_C), true);

    // Protection is explicit as well as implicit.
    assert.deepEqual(store.prune(0, [SHA_C]), []);
    assert.deepEqual(store.prune(0), [SHA_C]);
    assert.equal(store.has(SHA_A), true);
  });
});

test('staging is cleared, not merged, so an interrupted run cannot leave a half tree behind', () => {
  inTmp((store) => {
    const first = store.stagingPath(SHA_A);
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, 'leftover.ts'), 'from an interrupted run\n');
    // Asking for the same staging path again wipes it rather than writing alongside.
    const second = store.stagingPath(SHA_A);
    assert.equal(existsSync(join(second, 'leftover.ts')), false);

    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'x.ts'), 'x\n');
    store.clearStaging();
    assert.equal(existsSync(second), false);
  });
});

test('list reports installed versions newest first, ignoring anything we did not put there', () => {
  inTmp((store) => {
    utimesSync(install(store, SHA_A), 1_700_000_000, 1_700_000_000);
    utimesSync(install(store, SHA_B), 1_700_000_500, 1_700_000_500);
    mkdirSync(join(store.root, 'versions', 'scratch-dir'));
    store.switchTo(SHA_B);
    const listed = store.list();
    assert.deepEqual(listed.map((v) => v.sha), [SHA_B, SHA_A]);
    assert.deepEqual(listed.map((v) => v.current), [true, false]);
  });
});

test('a broken current link does not stop the store listing what is on disk', () => {
  inTmp((store) => {
    install(store, SHA_A);
    symlinkSync(join('versions', SHA_B), store.currentLink); // points at a version that is not there
    assert.throws(() => store.currentSha(), VersionStoreError);
    assert.deepEqual(store.list().map((v) => v.sha), [SHA_A], 'list still works, so a repair can be diagnosed');
    assert.equal(lstatSync(store.currentLink).isSymbolicLink(), true);
  });
});
