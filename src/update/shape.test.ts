/**
 * The shape check: the cheap rung that catches a wrong repository, a truncated fetch, and — the one
 * that matters most — a version that needs a newer Node than this machine has.
 *
 * That last one is a classic way for an auto-updater to brick a deployment. Everything verifies,
 * the switch happens, and the daemon then dies on a syntax error from a language feature the old
 * runtime cannot parse. Catching it here costs a JSON parse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkShape, engineSatisfied, versionAtLeast } from './shape.ts';

/** A checkout that passes: the required modules, a matching package.json, and enough files. */
function buildTree(dir: string, overrides: { pkg?: unknown; omit?: readonly string[]; files?: number; tests?: number } = {}): void {
  const required = [
    'src/main.ts',
    'src/ops/cli.ts',
    'src/store/account-registry.ts',
    'src/store/sqlite-mailbox.ts',
    'src/server/smtp-receiver.ts',
    'src/server/imap-server.ts',
  ];
  const omit = new Set(overrides.omit ?? []);
  for (const rel of required) {
    if (omit.has(rel)) continue;
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `// ${rel}\n`);
  }
  if (!omit.has('package.json')) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(overrides.pkg ?? { name: 'cutiemail', engines: { node: '>=22.18.0' } }),
    );
  }
  mkdirSync(join(dir, 'src', 'filler'), { recursive: true });
  for (let i = 0; i < (overrides.files ?? 250); i++) writeFileSync(join(dir, 'src', 'filler', `f${i}.ts`), '//\n');
  for (let i = 0; i < (overrides.tests ?? 120); i++) writeFileSync(join(dir, 'src', 'filler', `t${i}.test.ts`), '//\n');
}

function inTree(overrides: Parameters<typeof buildTree>[1], fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-shape-'));
  try {
    buildTree(dir, overrides);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a well-formed checkout passes', () => {
  inTree({}, (dir) => {
    const result = checkShape(dir, 'v22.18.0');
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });
});

test('a missing load-bearing module is named', () => {
  inTree({ omit: ['src/server/imap-server.ts'] }, (dir) => {
    const result = checkShape(dir, 'v22.18.0');
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, ['missing src/server/imap-server.ts']);
  });
});

test('a checkout of the wrong project is caught before anything expensive runs', () => {
  inTree({ pkg: { name: 'some-other-thing', engines: { node: '>=22.18.0' } } }, (dir) => {
    assert.match(checkShape(dir, 'v22.18.0').findings.join('\n'), /names the project "some-other-thing".*MAIL_UPDATE_REPO/s);
  });
});

test('a truncated tree is caught even when the required files survived', () => {
  inTree({ files: 5, tests: 2 }, (dir) => {
    const findings = checkShape(dir, 'v22.18.0').findings.join('\n');
    assert.match(findings, /file\(s\) in the checkout.*truncated/);
    // Without this second floor, a tree that lost its tests would make the regression gate pass by
    // having nothing to run.
    assert.match(findings, /test file\(s\).*regression gate would have nothing to run/);
  });
});

test('a version needing a newer Node than this machine has is refused, not discovered after the switch', () => {
  inTree({ pkg: { name: 'cutiemail', engines: { node: '>=24.0.0' } } }, (dir) => {
    assert.match(checkShape(dir, 'v22.18.0').findings.join('\n'), /needs node >=24\.0\.0 but the running node is 22\.18\.0/);
  });
  // The negative control: the same requirement on a machine that meets it.
  inTree({ pkg: { name: 'cutiemail', engines: { node: '>=24.0.0' } } }, (dir) => {
    assert.deepEqual(checkShape(dir, 'v24.1.0').findings, []);
  });
});

test('a runtime requirement we cannot evaluate is refused rather than assumed satisfied', () => {
  // A range we guess at wrong is exactly the case that brings the service down, so an unreadable
  // one is a refusal.
  for (const range of ['^22.0.0', '>=22 <24', '22.x', 'latest', '']) {
    assert.equal(engineSatisfied(range, 'v22.18.0').ok, false, range);
  }
  inTree({ pkg: { name: 'cutiemail' } }, (dir) => {
    assert.match(checkShape(dir, 'v22.18.0').findings.join('\n'), /declares no engines.node/);
  });
});

test('version comparison handles the shapes that appear in practice', () => {
  assert.equal(versionAtLeast('22.18.0', '22.18.0'), true);
  assert.equal(versionAtLeast('22.18.1', '22.18.0'), true);
  assert.equal(versionAtLeast('22.9.0', '22.18.0'), false, '9 < 18: this is not a string comparison');
  assert.equal(versionAtLeast('23.0.0', '22.18.0'), true);
  assert.equal(versionAtLeast('22.18', '22.18.0'), true, 'a missing component counts as zero');
  assert.equal(versionAtLeast('23.0.0-nightly', '22.18.0'), true, 'a pre-release suffix is ignored');
  assert.equal(engineSatisfied('>= v22.18.0', 'v22.18.0').ok, true, 'the range may be spaced and v-prefixed');
});

test('an empty required file is as bad as a missing one', () => {
  inTree({}, (dir) => {
    writeFileSync(join(dir, 'src', 'main.ts'), '');
    assert.match(checkShape(dir, 'v22.18.0').findings.join('\n'), /src\/main\.ts is empty/);
  });
});

test('an unparseable package.json is reported, not thrown', () => {
  inTree({}, (dir) => {
    writeFileSync(join(dir, 'package.json'), '{ not json');
    const result = checkShape(dir, 'v22.18.0');
    assert.equal(result.ok, false);
    assert.match(result.findings.join('\n'), /package\.json does not parse/);
  });
});
