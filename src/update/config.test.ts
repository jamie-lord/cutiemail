/**
 * Updater configuration.
 *
 * The interesting cases are the ones that must NOT fall back to a default. A typo in a size limit
 * costs a suboptimal number; a typo in the mode either disables updates the operator asked for or
 * hands an unattended process the keys they did not, and neither is something to guess at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateConfigFromEnv, parseRepoUrl, validBranchName, UpdateConfigError, DEFAULT_REPO_URL } from './config.ts';

const DAY_MS = 86_400_000;

test('an empty environment gives a safe, check-only default', () => {
  const cfg = updateConfigFromEnv({});
  assert.equal(cfg.mode, 'check', 'automatic switching is off until the mechanism has earned trust');
  assert.equal(cfg.repoUrl, DEFAULT_REPO_URL);
  assert.equal(cfg.branch, 'main');
  assert.equal(cfg.bakeMs, 3 * DAY_MS);
  assert.equal(cfg.staleMs, 30 * DAY_MS);
});

test('the mode is never guessed', () => {
  for (const mode of ['off', 'check', 'apply']) {
    assert.equal(updateConfigFromEnv({ MAIL_UPDATE_MODE: mode }).mode, mode);
  }
  // Guessing 'off' silently disables updates; guessing 'apply' hands over the keys. Both are worse
  // than an error naming what was typed.
  for (const typo of ['aply', 'on', 'true', '1', 'APPLY', ' apply']) {
    assert.throws(() => updateConfigFromEnv({ MAIL_UPDATE_MODE: typo }), UpdateConfigError, typo);
  }
});

test('the remote must be reachable over TLS, because nothing else authenticates the code', () => {
  assert.equal(parseRepoUrl('https://github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
  for (const bad of ['http://one.example/repo.git', 'git://one.example/repo.git', 'ssh://git@one.example/repo.git', 'file:///srv/repo', 'not a url']) {
    assert.throws(() => parseRepoUrl(bad), UpdateConfigError, bad);
  }
  // Loopback http is the one carve-out, and it exists so the protocol client can be exercised
  // against a real server; no deployment points at its own machine.
  assert.doesNotThrow(() => parseRepoUrl('http://127.0.0.1:8080/repo.git'));
  assert.doesNotThrow(() => parseRepoUrl('http://localhost:8080/repo.git'));
});

test('a branch name that could break the request framing is refused', () => {
  for (const ok of ['main', 'release/2', 'v1.2', 'feature-x']) assert.equal(validBranchName(ok), true, ok);
  for (const bad of [
    '',
    'main branch', // a space would split the pkt-line into two arguments
    'main\nwant deadbeef', // a newline would inject a second request line
    'main\0',
    'refs/../../other',
    'main..other',
    'main~1',
    'main^',
    'main:x',
    'main?',
    'main*',
    'main[1]',
    'main\\x',
    '/main',
    'main/',
    '-main',
    'main.',
    'a@{0}',
    'a'.repeat(256),
  ]) {
    assert.equal(validBranchName(bad), false, JSON.stringify(bad));
    assert.throws(() => updateConfigFromEnv({ MAIL_UPDATE_BRANCH: bad }), UpdateConfigError, JSON.stringify(bad));
  }
});

test('numeric settings fail loud rather than silently reverting to a default', () => {
  assert.equal(updateConfigFromEnv({ MAIL_UPDATE_BAKE_DAYS: '0' }).bakeMs, 0, 'zero bake time is a legitimate choice');
  assert.equal(updateConfigFromEnv({ MAIL_UPDATE_KEEP: '0' }).keepVersions, 0);
  assert.equal(updateConfigFromEnv({ MAIL_UPDATE_BAKE_DAYS: '' }).bakeMs, 3 * DAY_MS, 'unset means the default');
  for (const [name, value] of [
    ['MAIL_UPDATE_BAKE_DAYS', '-1'],
    ['MAIL_UPDATE_BAKE_DAYS', 'three'],
    ['MAIL_UPDATE_BAKE_DAYS', '1.5'],
    ['MAIL_UPDATE_STALE_DAYS', '0'],
    ['MAIL_UPDATE_DRAIN_SECONDS', '0'],
    ['MAIL_UPDATE_PROBE_SECONDS', '-5'],
    ['MAIL_UPDATE_MAX_DEPTH', 'lots'],
  ] as const) {
    assert.throws(() => updateConfigFromEnv({ [name]: value }), UpdateConfigError, `${name}=${value}`);
  }
});
