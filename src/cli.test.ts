/**
 * CLI integration: the suite as an executable, end to end.
 *
 * Spawns the CLI as a real subprocess against a live mutant server, because the
 * exit code is part of the contract — a CI pipeline greps nothing, it checks
 * `$?`. A finding must exit 1; a clean run must exit 0; a config error must
 * exit 2. These are the behaviours an operator's automation depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MutantServer } from './testing/mutant-server.ts';
import type { Defects } from './testing/mutant-server.ts';

const CLI = new URL('./cli.ts', import.meta.url).pathname;

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

async function withConfig(
  defects: Defects,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const server = await MutantServer.start({ defects, validRecipients: ['recipient@example.com'] });
  const dir = mkdtempSync(join(tmpdir(), 'smtp-cli-'));
  const configPath = join(dir, 'target.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'mutant',
      serverDomain: 'mutant.test',
      host: '127.0.0.1',
      port: server.port,
      version: 'test',
      fixture: { clientDomain: 'conformance-suite.invalid', validRecipient: 'recipient@example.com' },
    }),
  );
  try {
    await fn(configPath);
  } finally {
    await server.close();
  }
}

test('run against a clean server exits 0 with no findings', async () => {
  await withConfig({}, async (configPath) => {
    const r = await runCli(['run', '--config', configPath, '--now', '2026-07-15T00:00:00Z']);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /0 X/);
    assert.doesNotMatch(r.stdout, /FINDINGS/);
  });
});

test('run against a smuggling-vulnerable server exits 1 and names the finding', async () => {
  await withConfig({ honourLfDotCrlfEndOfData: true }, async (configPath) => {
    const r = await runCli(['run', '--config', configPath, '--now', '2026-07-15T00:00:00Z']);
    assert.equal(r.code, 1, `expected exit 1 on a finding, got ${r.code}`);
    assert.match(r.stdout, /FINDINGS \(1\)/);
    assert.match(r.stdout, /R-5321-4\.1\.1\.4-i/);
    assert.match(r.stdout, /<LF>\.<CR><LF>/);
  });
});

test('run against an unreachable target exits 2 and says so — never a false green', async () => {
  // The false-green trap: nothing listening at the target meant 68/68 inconclusive,
  // "No substantive divergences", and exit 0 — a typo'd host or a server that failed to
  // boot passed CI forever. All-inconclusive now exits 2 with the reasons printed.
  const dir = mkdtempSync(join(tmpdir(), 'smtp-cli-dead-'));
  const configPath = join(dir, 'target.json');
  // Grab an ephemeral port that is then closed again — guaranteed unoccupied.
  const probe = await MutantServer.start({ defects: {}, validRecipients: ['r@example.com'] });
  const deadPort = probe.port;
  await probe.close();
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'dead',
      serverDomain: 'dead.test',
      host: '127.0.0.1',
      port: deadPort,
      version: 'test',
      fixture: { clientDomain: 'conformance-suite.invalid', validRecipient: 'r@example.com' },
    }),
  );
  const r = await runCli(['run', '--config', configPath, '--now', '2026-07-15T00:00:00Z']);
  assert.equal(r.code, 2, `expected exit 2 against a dead target, got ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /inconclusive; nothing was verified/i);
  assert.match(r.stderr, /Is the target listening/i);
});

test('a missing config exits 2', async () => {
  const r = await runCli(['run', '--config', '/nonexistent/target.json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /config error/);
});

test('coverage runs with no server and exits 0', async () => {
  const r = await runCli(['coverage']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /CONFORMANCE COVERAGE/);
});

test('list shows cases and exits 0', async () => {
  const r = await runCli(['list']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /R-5321-/);
  assert.match(r.stdout, /negative controls/);
});

test('an unknown command exits 2 with usage', async () => {
  const r = await runCli(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command/);
});
