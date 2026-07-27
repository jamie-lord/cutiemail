/**
 * Rung 4: does the tree run on THIS machine?
 *
 * The cases here are built from real trees on disk and a real child Node, because the whole point
 * of the rung is that it uses the runtime that is actually installed. A mocked import would test
 * this file's opinion of module loading rather than module loading.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateModules, checkExecutable } from './executable.ts';

/** A miniature candidate: `files` are written under <dir>/src. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, 'src', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

const ENV = { PATH: process.env.PATH ?? '' };

test('every non-test module is enumerated, in a stable order, with tests excluded', () => {
  const dir = tree({
    'b.ts': 'export const b = 1;\n',
    'a.ts': 'export const a = 1;\n',
    'a.test.ts': 'throw new Error("a test must never be imported by this rung");\n',
    'deep/c.ts': 'export const c = 1;\n',
  });
  try {
    const modules = candidateModules(dir);
    assert.deepEqual(modules, ['src/a.ts', 'src/b.ts', 'src/deep/c.ts']);
    assert.ok(!modules.some((m) => m.endsWith('.test.ts')), 'test files are not part of the shipped program');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree that loads is reported with the runtime it loaded under', async () => {
  const dir = tree({ 'a.ts': 'export const a = 1;\n', 'b.ts': "import { a } from './a.ts';\nexport const b = a + 1;\n" });
  try {
    const result = await checkExecutable(dir, ENV);
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.modules, 2);
    assert.match(result.detail, /2 modules load under v/, result.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module the runtime cannot parse is refused, and named', async () => {
  // The failure this rung exists for: syntactically valid to the author, unparseable here. A
  // version adopting a language feature the installed Node predates looks exactly like this, and
  // satisfies engines.node — which is a declaration, not evidence.
  const dir = tree({ 'fine.ts': 'export const ok = 1;\n', 'broken.ts': 'export const x = ;\n' });
  try {
    const result = await checkExecutable(dir, ENV);
    assert.equal(result.ok, false);
    // The detail must BE the named failure, not a dump that happens to contain the name. An
    // operator reading `src/broken.ts: Unexpected token` has the whole answer; one reading `exit 1`
    // followed by four kilobytes of output has to go looking. (A mutation that removed the naming
    // path survived until this assertion was tightened: the raw output contained the name anyway.)
    assert.ok(result.detail.startsWith('src/broken.ts:'), `the failing module is named first: ${result.detail.slice(0, 120)}`);
    assert.ok(!result.detail.startsWith('exit '), 'not a raw process dump');
    assert.ok(!/src\/fine\.ts/.test(result.detail.split('\n')[0] ?? ''), 'and the ones that loaded are not');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module that throws on import is refused — a broken import graph is not executable', async () => {
  const dir = tree({ 'a.ts': "import './missing.ts';\nexport const a = 1;\n" });
  try {
    const result = await checkExecutable(dir, ENV);
    assert.equal(result.ok, false);
    assert.match(result.detail, /src\/a\.ts/, result.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree with no modules at all is refused rather than trivially passing', async () => {
  // The shape floors in rung 3 are the main guard against a truncated checkout, but a rung that
  // answers "ok" when it examined nothing is the kind of check that makes a ladder look longer
  // than it is.
  const dir = mkdtempSync(join(tmpdir(), 'candidate-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  try {
    const result = await checkExecutable(dir, ENV);
    assert.equal(result.ok, false);
    assert.match(result.detail, /no modules/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('this project\'s own tree loads — every module, under this runtime', async () => {
  // The rung against the real thing, which is also the negative control for every case above: if
  // checkExecutable refused everything, this would fail.
  const repo = join(import.meta.dirname, '..', '..');
  const result = await checkExecutable(repo, { PATH: process.env.PATH ?? '' });
  assert.equal(result.ok, true, result.detail);
  // `modules` is the count FOUND, not the count imported, so on its own this asserts nothing about
  // coverage — it read the same 226 while the sweep imported four. What makes `ok` mean "swept" is
  // the completion check inside checkExecutable, pinned by the test below.
  assert.ok(result.modules > 150, `the whole tree was found: ${result.modules} modules`);
});

test('a module that exits during the sweep fails the rung instead of ending it quietly', async () => {
  // The rung's own governing rule is that it must be able to fail for a reason CI could not have
  // caught. It could not fail for this one. The child ends with an explicit process.exit(0), and a
  // module that calls the same thing at import time — the commonest command-line entry-point shape
  // there is — ended the child with status 0 and no LOAD-FAILED line, which was the entirety of the
  // parent's success test. Everything after it was never imported and the rung said so was fine.
  //
  // Not hypothetical: this tree shipped two modules with unconditional import-time side effects,
  // found by this rung on its first real run against a deployment (see b0f4d61). Neither exited 0,
  // which is the only reason the gap stayed invisible.
  const dir = tree({
    'aaa-exits.ts': 'process.exit(0);\n',
    'zzz-broken.ts': 'export const broken = ;\n',
  });
  try {
    const result = await checkExecutable(dir, ENV);
    assert.equal(result.ok, false, 'the sweep must not report success having stopped early');
    assert.match(result.detail, /completed 0\/2 modules/, result.detail);
    assert.match(result.detail, /stopped in src\/aaa-exits\.ts/, `and it names where it stopped: ${result.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
