/**
 * Rung 3 of the ladder: is this checkout a cutiemail version at all?
 *
 * Cheap, and it catches the failures that are embarrassing to discover later — a fetch that
 * silently truncated, a repository URL pointing at the wrong project, a version that needs a newer
 * Node than this machine has. Every one of those would otherwise be found by rung 4 or 5 after
 * minutes of work, or worse, by rung 8 after the switch.
 *
 * The Node engine check is the one that earns its place. "The new version requires a runtime the
 * host does not have" is a classic way for an auto-updater to brick a deployment: everything
 * verifies, the switch happens, and the daemon then refuses to start with a syntax error from a
 * feature the old runtime does not parse. Refusing here means the operator gets a message telling
 * them to upgrade Node, while the working version keeps running.
 *
 * This is not a security boundary. A hostile tree could contain all of these files and a matching
 * package.json; what stops a hostile tree is provenance (ADR 0025), not shape.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ShapeResult {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly files: number;
}

/** Files without which this is not a runnable cutiemail. */
const REQUIRED_FILES = [
  'package.json',
  'src/main.ts',
  'src/ops/cli.ts',
  'src/store/account-registry.ts',
  'src/store/sqlite-mailbox.ts',
  'src/server/smtp-receiver.ts',
  'src/server/imap-server.ts',
];

/**
 * A truncated tree that still happens to contain the required files would sail through, and rung 4
 * would then run whatever tests survived and call it a pass. A floor on the total file count and on
 * the test count makes that specific silence impossible.
 */
const MIN_FILES = 200;
const MIN_TEST_FILES = 100;

/** Parse a dotted version into comparable numbers, ignoring any pre-release suffix. */
function versionParts(v: string): number[] {
  return v.split('-')[0]!.split('.').map((p) => Number(p) || 0);
}

/** Is `version` at least `min`? Both dotted; missing components count as zero. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = versionParts(version);
  const b = versionParts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Check a candidate's `engines.node` against the runtime that would execute it.
 *
 * Only the `>=X.Y.Z` form is understood, because that is the only form this project has ever used
 * and guessing at the rest of the npm range grammar would be a parser nobody reviews. Anything else
 * is reported as unreadable rather than assumed satisfied — a range we cannot evaluate is exactly
 * the case where a wrong guess brings the service down.
 */
export function engineSatisfied(range: string, nodeVersion: string): { ok: boolean; reason: string } {
  const m = /^>=\s*v?(\d+(?:\.\d+)*)$/.exec(range.trim());
  if (m === null) {
    return { ok: false, reason: `engines.node is ${JSON.stringify(range)}, which this check cannot evaluate (only ">=X.Y.Z" is understood)` };
  }
  const min = m[1]!;
  const running = nodeVersion.replace(/^v/, '');
  return versionAtLeast(running, min)
    ? { ok: true, reason: `node ${running} satisfies ${range}` }
    : { ok: false, reason: `this version needs node ${range} but the running node is ${running}: it would fail to start after the switch` };
}

/** Count files under `dir`, and how many of them are tests, bounded so a vast tree cannot wedge us. */
function countFiles(dir: string, limit: number): { files: number; tests: number } {
  let files = 0;
  let tests = 0;
  const stack = [dir];
  while (stack.length > 0 && files < limit) {
    const at = stack.pop()!;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        files++;
        if (entry.name.endsWith('.test.ts')) tests++;
        if (files >= limit) break;
      }
    }
  }
  return { files, tests };
}

export function checkShape(dir: string, nodeVersion: string = process.version): ShapeResult {
  const findings: string[] = [];

  for (const rel of REQUIRED_FILES) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      findings.push(`missing ${rel}`);
      continue;
    }
    if (statSync(path).size === 0) findings.push(`${rel} is empty`);
  }

  let pkg: { name?: unknown; engines?: { node?: unknown } } = {};
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
    } catch (e) {
      findings.push(`package.json does not parse: ${String(e)}`);
    }
  }
  if (pkg.name !== undefined && pkg.name !== 'cutiemail') {
    // A wrong repository URL is a configuration mistake, not an attack, and this is where it shows.
    findings.push(`package.json names the project ${JSON.stringify(pkg.name)}, not "cutiemail": is MAIL_UPDATE_REPO pointing at the right repository?`);
  }
  const engines = pkg.engines?.node;
  if (typeof engines !== 'string') findings.push('package.json declares no engines.node, so the runtime requirement cannot be checked');
  else {
    const verdict = engineSatisfied(engines, nodeVersion);
    if (!verdict.ok) findings.push(verdict.reason);
  }

  const { files, tests } = countFiles(dir, 100_000);
  if (files < MIN_FILES) findings.push(`only ${files} file(s) in the checkout, expected at least ${MIN_FILES}: the tree looks truncated`);
  if (tests < MIN_TEST_FILES) {
    // Without this, a tree that lost its tests would make rung 4 pass by having nothing to run.
    findings.push(`only ${tests} test file(s) in the checkout, expected at least ${MIN_TEST_FILES}: the regression gate would have nothing to run`);
  }

  return { ok: findings.length === 0, findings, files };
}
