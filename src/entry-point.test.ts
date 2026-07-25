/**
 * The entry-point guard, exercised against a real symlink.
 *
 * These cases run an actual `node` process, because the bug this file pins is only visible in one:
 * the guard compares a resolved URL against an unresolved argv[1], and every in-process test of it
 * would have to construct both by hand and would therefore agree with whatever the author believed.
 * The failure mode is also silent — exit 0, no output — so the assertion has to be on what the
 * program DID, not on whether it crashed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokedDirectly } from './entry-point.ts';

const HERE = realpathSync(import.meta.filename);

test('a module is its own program when argv[1] names it, however that path is spelled', () => {
  assert.equal(invokedDirectly(import.meta.url, HERE), true, 'the real path matches');
  // The same file reached through a directory symlink must still count as the program. This is the
  // deployment case: ExecStart goes through `current`, which is a symlink to versions/<commit>.
  const dir = mkdtempSync(join(tmpdir(), 'entry-'));
  try {
    const link = join(dir, 'link');
    symlinkSync(realpathSync(import.meta.dirname), link);
    assert.equal(invokedDirectly(import.meta.url, join(link, 'entry-point.test.ts')), true, 'through a symlink it is still the program');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module being imported is not the program', () => {
  assert.equal(invokedDirectly(import.meta.url, join(import.meta.dirname, 'main.ts')), false);
  // No argv[1] at all: `node -e`, or the REPL. False is the safe answer — a module that wrongly
  // decides it IS the program starts a mail server inside whatever imported it.
  assert.equal(invokedDirectly(import.meta.url, undefined), false);
  assert.equal(invokedDirectly(import.meta.url, ''), false);
  // A path that cannot be resolved must not throw out of the guard.
  assert.equal(invokedDirectly(import.meta.url, join(import.meta.dirname, 'no-such-file-here.ts')), false);
});

test('the daemon actually runs when started through a symlinked directory', () => {
  // The regression this exists for, end to end in a real process. A version store is laid out the
  // way ADR 0025 specifies — versions/<name>, with `current` pointing at it — and the program is
  // started through `current`, exactly as the systemd unit does.
  const root = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const version = join(root, 'versions', 'v1');
    mkdirSync(version, { recursive: true });
    // A stand-in for main.ts: it prints only if it decides it is the program.
    writeFileSync(
      join(version, 'prog.ts'),
      [
        `import { invokedDirectly } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'entry-point.ts')).href)};`,
        'if (invokedDirectly(import.meta.url, process.argv[1])) console.log("RAN");',
        '',
      ].join('\n'),
    );
    symlinkSync(join(root, 'versions', 'v1'), join(root, 'current'));

    const direct = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(version, 'prog.ts')], { encoding: 'utf8' });
    assert.equal(direct.trim(), 'RAN', 'started by its real path');

    const viaLink = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'current', 'prog.ts')], { encoding: 'utf8' });
    assert.equal(viaLink.trim(), 'RAN', 'started through the `current` symlink — the deployment path');

    // And the negative control: the guard still says no when the file is merely imported, so the
    // case above is not passing because the guard answers true to everything.
    const importer = join(root, 'importer.ts');
    writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(join(version, 'prog.ts')).href)};\nconsole.log("IMPORTED");\n`);
    const imported = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', importer], { encoding: 'utf8' });
    assert.equal(imported.trim(), 'IMPORTED', 'importing it runs nothing of its own');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
