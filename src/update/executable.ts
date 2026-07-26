/**
 * "Will this tree actually run on THIS machine?" — rung 4.
 *
 * The rung this replaces ran the candidate's entire test suite. That was the wrong question asked
 * at great expense. Rungs 1 and 2 have already proved the checkout is byte-identical to a specific
 * commit, so its tests have been run, on that exact content, by CI. Re-running deterministic tests
 * here re-answers a settled question: a sequence-set parser or a DKIM vector cannot behave
 * differently on a Hetzner box than on a laptop. What it CAN do is take fifteen minutes on the two
 * shared cores this project's own deploy script provisions by default, and refuse a perfectly good
 * update when a wall-clock-sensitive test flakes under that contention — teaching an operator that
 * the safe move is to turn updates off.
 *
 * The governing rule for every rung is now: **a pre-flight check must be able to fail for a reason
 * CI could not have caught.** Applied here, exactly one thing survives from the old rung — whether
 * the Node that is actually installed can parse and evaluate this code. That is a real risk and a
 * local one: `engines.node` (checked in rung 3) is a DECLARATION, and a declaration is a claim
 * about a range, not evidence that this runtime can read this syntax. A version that adopts a
 * language feature the installed Node predates satisfies every declared constraint and then dies at
 * the first import after the switch.
 *
 * So: import every module the candidate ships. Not a sample, not the entry points — all of them,
 * because the failure is per-file and the one that matters is the file nobody thought to name.
 *
 * This is only safe to do because the entry-point guard is correct: a module that decides it is the
 * program when it is merely being imported would start a mail server inside this check. See
 * entry-point.ts, and note that the two are load-bearing for each other.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from './candidate-process.ts';

/**
 * How long the import sweep may take.
 *
 * Generous against what the work costs — importing a few hundred modules is seconds even on a
 * small box — and small enough that it cannot become the reason an update never lands. The rung it
 * replaces failed on precisely that.
 */
const IMPORT_TIMEOUT_MS = 120_000;

/** Every non-test TypeScript module under `dir`, relative to it, in a stable order. */
export function candidateModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(relative(dir, child));
    }
  };
  walk(join(dir, 'src'));
  return out;
}

export interface ExecutableResult {
  readonly ok: boolean;
  readonly modules: number;
  /** The first module that would not load, and why. Empty when everything loaded. */
  readonly detail: string;
}

/**
 * Import every module of the candidate in a child process running the installed Node.
 *
 * A child process, not this one, for two reasons: the updater must not end up holding the
 * candidate's modules in its own graph, and a module that crashes the process on load is a result
 * to report rather than a reason for the updater to die.
 *
 * Modules are imported ONE AT A TIME and the failing one is named. "Something in the tree does not
 * load" would send an operator hunting; "src/imap/search.ts: Unexpected token" is the whole answer.
 */
export async function checkExecutable(candidateDir: string, env: Record<string, string>): Promise<ExecutableResult> {
  const modules = candidateModules(candidateDir);
  if (modules.length === 0) return { ok: false, modules: 0, detail: 'the candidate ships no modules under src/' };

  // The list is EMBEDDED in the script rather than passed as an argument, which matters more than
  // it looks. Under `--eval`, extra arguments land in `process.argv[1]` — the very slot an entry
  // point reads to decide whether it is the program being run. Handing a module graph a JSON blob
  // there means every module that inspects argv[1] at import time sees nonsense, and this project
  // has exactly such a guard by design (entry-point.ts). Passing the data out of band leaves argv
  // looking the way a loaded module expects.
  const list = JSON.stringify(modules.map((name) => ({ name, url: pathToFileURL(join(candidateDir, name)).href })));
  const script = [
    `const modules = ${list};`,
    'for (const m of modules) {',
    '  try { await import(m.url); }',
    '  catch (e) {',
    '    console.log(`LOAD-FAILED ${m.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);',
    '    process.exit(1);',
    '  }',
    '}',
    'console.log(`LOADED ${modules.length}`);',
    // Exit explicitly. A module that leaves a timer or a listener behind would otherwise hold this
    // process open long past the point where the question was answered, and the rung would report a
    // timeout when every module in fact loaded. What this rung measures is loading.
    'process.exit(0);',
  ].join('\n');

  const result = await runCommand(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script],
    { cwd: candidateDir, env, timeoutMs: IMPORT_TIMEOUT_MS },
  );
  if (result.timedOut) {
    // A module that hangs on import is as broken as one that throws, and more dangerous: systemd
    // would sit through TimeoutStartSec waiting for a daemon that is never going to be ready.
    return { ok: false, modules: modules.length, detail: `importing the candidate's modules did not finish within ${IMPORT_TIMEOUT_MS}ms` };
  }
  const failed = /^LOAD-FAILED (.*)$/m.exec(result.output);
  if (failed !== null) return { ok: false, modules: modules.length, detail: failed[1] ?? result.output.slice(-2000) };
  if (result.code !== 0) return { ok: false, modules: modules.length, detail: `exit ${String(result.code)}\n${result.output.slice(-2000)}` };
  return { ok: true, modules: modules.length, detail: `${modules.length} modules load under ${process.version}` };
}
