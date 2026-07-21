/**
 * The command-line entry point.
 *
 * Ties the pieces into something an operator can actually run:
 *
 *   node src/cli.ts run   --config target.json           run the corpus against a server
 *   node src/cli.ts coverage                             print the register coverage report
 *   node src/cli.ts list                                 list every corpus case and its requirement
 *
 * Deliberately thin — it parses argv, loads config, calls the same runSuite the
 * tests use, and renders the existing reports. No logic lives here that isn't
 * also reachable programmatically, so the CLI is a convenience over the library,
 * never a second implementation.
 */

import { argv, stdout, stderr } from 'node:process';
import { loadTargetConfig, connectOptions, ConfigError } from './conformance/config.ts';
import { runSuite } from './conformance/runner.ts';
import { withPostmasterConvention } from './conformance/fixture.ts';
import { ALL_CASES, ALL_MUTANTS, LATITUDE_CONTROLLED_IDS } from './corpus/index.ts';
import { computeCoverage, renderCoverage } from './report/coverage.ts';
import { buildMatrix, renderMatrix } from './report/matrix.ts';
import { explain, isFinding } from './conformance/outcome.ts';
import { requirement } from './register/rfc5321.ts';

function usage(): string {
  return [
    'SMTP conformance suite (RFC 5321)',
    '',
    'Usage:',
    '  node src/cli.ts run --config <file.json> [--verbose] [--now <iso8601>]',
    '  node src/cli.ts coverage',
    '  node src/cli.ts list',
    '',
    'Commands:',
    '  run       Run the corpus against the server described by --config.',
    '  coverage  Print the register coverage report (no server needed).',
    '  list      List every corpus case with the requirement it checks.',
    '',
    '--now lets a caller stamp the run time (the runtime forbids reading the clock',
    'in some contexts); defaults to the value passed or an empty marker.',
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function cmdRun(args: string[]): Promise<number> {
  const configPath = flag(args, '--config');
  if (configPath === undefined) {
    stderr.write('run requires --config <file.json>\n');
    return 2;
  }
  const verbose = args.includes('--verbose');
  const now = flag(args, '--now') ?? 'unstamped';

  let target;
  try {
    target = loadTargetConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const fixture = withPostmasterConvention(target.fixture, target.serverDomain);
  stdout.write(`Running ${ALL_CASES.length} cases against ${target.name} (${target.host}:${target.port})...\n`);

  const results = await runSuite(ALL_CASES, {
    connect: connectOptions(target),
    fixture,
    ...(target.replyTimeoutMs !== undefined ? { replyTimeoutMs: target.replyTimeoutMs } : {}),
    ...(target.caseTimeoutMs !== undefined ? { caseTimeoutMs: target.caseTimeoutMs } : {}),
  });

  const matrix = buildMatrix([
    {
      meta: {
        serverName: target.name,
        serverVersion: target.version,
        runAt: now,
        suiteCommit: undefined,
      },
      results,
    },
  ]);
  stdout.write('\n' + renderMatrix(matrix) + '\n');

  const findings = results.filter((r) => isFinding(r.outcome));
  if (findings.length > 0) {
    stdout.write(`\nFINDINGS (${findings.length}):\n\n`);
    for (const f of findings) {
      stdout.write(explain(f) + '\n\n');
    }
  }

  // A run where EVERY case is inconclusive verified nothing — the usual cause is a target
  // that isn't listening at all (typo'd host/port, a server that failed to boot). Per-case
  // that is correctly "inconclusive, not non-conformant", but reporting the aggregate as a
  // clean exit-0 run would be a permanent false green in CI (the README sells the exit-code
  // contract). Print the reasons unconditionally and exit 2 (target/config error).
  const allInconclusive = results.length > 0 && results.every((r) => r.outcome === 'inconclusive');
  if (allInconclusive) {
    stderr.write(`\nAll ${results.length} cases were inconclusive — nothing was verified. Is the target listening at ${target.host}:${target.port}?\n`);
    const reasons = new Map<string, number>();
    for (const r of results) {
      const reason = r.judgement.kind === 'inconclusive' ? r.judgement.reason : '(unknown)';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of reasons) stderr.write(`  ${count}x ${reason}\n`);
    return 2;
  }

  if (verbose) {
    const inconclusive = results.filter((r) => r.outcome === 'inconclusive');
    if (inconclusive.length > 0) {
      stdout.write(`\nINCONCLUSIVE (${inconclusive.length}) — usually missing fixtures:\n`);
      for (const r of inconclusive) {
        const reason = r.judgement.kind === 'inconclusive' ? r.judgement.reason : '';
        stdout.write(`  ${r.testId} (${r.requirementId}): ${reason}\n`);
      }
    }
  }

  // Exit non-zero iff there is a genuine finding. Inconclusive is not failure.
  return findings.length > 0 ? 1 : 0;
}

function cmdCoverage(): number {
  stdout.write(renderCoverage(computeCoverage(ALL_CASES, ALL_MUTANTS, LATITUDE_CONTROLLED_IDS)) + '\n');
  return 0;
}

function cmdList(): number {
  const sorted = [...ALL_CASES].sort((a, b) => a.requirement.localeCompare(b.requirement));
  for (const c of sorted) {
    const level = requirement(c.requirement).level;
    stdout.write(`${c.requirement} (${level})  ${c.id}\n    ${c.intent}\n`);
  }
  stdout.write(`\n${ALL_CASES.length} cases, ${ALL_MUTANTS.length} negative controls.\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];
  switch (command) {
    case 'run':
      return cmdRun(args.slice(1));
    case 'coverage':
      return cmdCoverage();
    case 'list':
      return cmdList();
    case undefined:
    case '--help':
    case '-h':
      stdout.write(usage() + '\n');
      return 0;
    default:
      stderr.write(`unknown command: ${command}\n\n${usage()}\n`);
      return 2;
  }
}

// Set process.exitCode rather than calling exit(): exit() terminates the process
// IMMEDIATELY, which truncates buffered stdout when it is a pipe or file (the matrix
// can be many lines). Setting exitCode lets Node drain stdout and exit naturally once
// the event loop empties — the run has already closed all its sockets. This was a real
// output-loss bug: `cli run` against a server that produced a large report printed only
// the first line before exit() cut it off.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 3;
  });
