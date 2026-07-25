/**
 * Running a candidate as a child process: the module that actually executes downloaded code.
 *
 * The candidates here are stand-ins, a handful of lines each, because the behaviour under test is
 * this module's and not the mail server's. That also lets them do things the real daemon cannot —
 * bind one listener and stop, ignore SIGTERM, print without end — which is precisely the set of
 * failures a checker has to survive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCandidate, runCommand, CandidateError } from './candidate-process.ts';

/** Write a stand-in candidate whose `src/main.ts` is `body`. */
function fakeCandidate(body: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cutiemail-candidate-')));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), body);
  return dir;
}

/** Listen on the ports named by the given environment variables and stay up. */
const listenOn = (vars: readonly string[], extra = ''): string => `
import net from 'node:net';
${extra}
for (const name of ${JSON.stringify(vars)}) {
  net.createServer((s) => s.end()).listen(Number(process.env[name]), '127.0.0.1');
}
`;

const ALL_THREE = ['MAIL_SMTP_PORT', 'MAIL_SUBMISSION_PORT', 'MAIL_IMAP_PORT'];

function inCandidate(body: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fakeCandidate(body);
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a candidate that serves all three ports is ready, and is told to bind loopback only', async () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'cutiemail-env-')), 'env.json');
  await inCandidate(
    listenOn(ALL_THREE, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));`),
    async (dir) => {
      const candidate = await startCandidate({
        // A real deployment's MAIL_HOST is a public address. It must not survive into a candidate:
        // the check would then be reachable from off the machine while running downloaded code
        // against a copy of every secret the live system holds.
        dir,
        env: { PATH: process.env.PATH ?? '', MAIL_HOST: '0.0.0.0', MAIL_SMTP_PORT: '25', MAIL_SUBMISSION_PORT: '587', MAIL_IMAP_PORT: '993' },
        readyTimeoutMs: 20_000,
        killGraceMs: 500,
      });
      try {
        const childEnv = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>;
        assert.equal(childEnv.MAIL_HOST, '127.0.0.1', 'the configured bind address is overridden, not inherited');
        for (const [name, port] of [
          ['MAIL_SMTP_PORT', candidate.ports.smtp],
          ['MAIL_SUBMISSION_PORT', candidate.ports.submission],
          ['MAIL_IMAP_PORT', candidate.ports.imap],
        ] as const) {
          assert.equal(childEnv[name], String(port), `${name} is the port this process reserved`);
          assert.ok(port > 0 && port < 65536);
          // Ephemeral, so the running daemon's own listeners are never disturbed.
          assert.ok(![25, 587, 993].includes(port), `${port} must not be a production port`);
        }
        assert.equal(new Set([candidate.ports.smtp, candidate.ports.submission, candidate.ports.imap]).size, 3, 'three distinct ports');
        assert.ok(candidate.readyMs >= 0);
      } finally {
        await candidate.stop();
        rmSync(join(seen, '..'), { recursive: true, force: true });
      }
    },
  );
});

test('a candidate serving only some of its listeners is refused, and told which are missing', async () => {
  // A partially-started mail server is not a working one: one that answers submission but not IMAP
  // would pass a laxer check and then fail every client.
  await inCandidate(listenOn(['MAIL_SMTP_PORT']), async (dir) => {
    await assert.rejects(
      () => startCandidate({ dir, env: { PATH: process.env.PATH ?? '' }, readyTimeoutMs: 2000, killGraceMs: 500 }),
      (e: Error) => {
        assert.ok(e instanceof CandidateError);
        assert.match(e.message, /did not start serving/);
        assert.match(e.message, /not listening: submission, imap/);
        return true;
      },
    );
  });
});

test('a candidate that exits early is noticed at once, with its own output attached', async () => {
  await inCandidate('console.error("could not open the database");\nprocess.exit(3);\n', async (dir) => {
    const started = Date.now();
    await assert.rejects(
      () => startCandidate({ dir, env: { PATH: process.env.PATH ?? '' }, readyTimeoutMs: 30_000, killGraceMs: 500 }),
      /exited before it was serving \(code 3.*could not open the database/s,
    );
    // Noticed, not waited out: without the exit check this would have burned the whole 30s deadline.
    assert.ok(Date.now() - started < 15_000, 'the early exit was detected rather than timed out');
  });
});

test('a candidate that ignores SIGTERM is killed anyway', async () => {
  await inCandidate(listenOn(ALL_THREE, "process.on('SIGTERM', () => {});"), async (dir) => {
    const candidate = await startCandidate({ dir, env: { PATH: process.env.PATH ?? '' }, readyTimeoutMs: 20_000, killGraceMs: 300 });
    const port = candidate.ports.smtp;
    await candidate.stop();
    // It cannot outlive the check and sit on the snapshot it was given.
    const stillThere = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    assert.equal(stillThere, false, 'the port is gone, so the process is gone');
  });
});

test('a candidate that will not stop talking cannot fill the updater with its output', async () => {
  await inCandidate(
    listenOn(ALL_THREE, "for (let i = 0; i < 40000; i++) console.log('x'.repeat(200) + ' line ' + i);"),
    async (dir) => {
      const candidate = await startCandidate({ dir, env: { PATH: process.env.PATH ?? '' }, readyTimeoutMs: 20_000, killGraceMs: 500 });
      try {
        // Wait for it to have produced far more than the cap.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !candidate.output().includes('line 39999')) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const output = candidate.output();
        // 8 MB was written; the head, the tail and an honest count of the gap are kept.
        assert.ok(output.length < 1_000_000, `output is bounded, got ${output.length} bytes`);
        assert.match(output, /line 0\b/, 'the head survives, which is where a startup error would be');
        assert.match(output, /bytes of output elided/, 'and the gap is stated rather than hidden');
      } finally {
        await candidate.stop();
      }
    },
  );
});

test('a command that overruns its deadline is killed along with everything it spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-runcommand-'));
  try {
    // A parent that spawns a long-lived child of its own and then waits: killing only the parent
    // would leave the grandchild holding its port after the pre-flight believed it had cleaned up.
    const marker = join(dir, 'grandchild.port');
    writeFileSync(
      join(dir, 'run.ts'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', \`
  const net = require('net');
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    require('fs').writeFileSync(${JSON.stringify(marker)}, String(s.address().port));
  });
  setInterval(() => {}, 1000);
\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
    );
    const started = Date.now();
    const result = await runCommand(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'run.ts')], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 2000,
    });
    assert.equal(result.timedOut, true);
    assert.ok(result.ms >= 2000 && Date.now() - started < 30_000);

    // The grandchild's port must be free: if the process group had not been killed, it would still
    // be listening.
    const port = Number(await import('node:fs').then((fs) => fs.readFileSync(marker, 'utf8')));
    assert.ok(port > 0, 'the grandchild really did get as far as listening');
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    assert.equal(free, true, 'the whole process group went, not just the command we started');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a command that finishes reports its exit code and output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-runcommand-ok-'));
  try {
    const result = await runCommand(process.execPath, ['-e', 'console.log("hello"); process.exit(7)'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 20_000,
    });
    assert.equal(result.code, 7);
    assert.equal(result.timedOut, false);
    assert.match(result.output, /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
