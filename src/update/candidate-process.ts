/**
 * Running a candidate version as a child process, safely.
 *
 * This is the first place the updater executes code it just downloaded, so the shape of it matters
 * more than the mechanics:
 *
 *   - **Loopback and ephemeral, always.** The candidate never binds 25, 587 or 993 and is never
 *     reachable from off the machine. The ports are chosen here, by this process, rather than left
 *     to configuration that could be wrong.
 *   - **Readiness is measured by the listeners, not by a log line.** All three ports accepting a
 *     connection is a property of being a mail server; a banner string is a property of one
 *     version's phrasing, and coupling the update path to it would mean the day the wording changes
 *     is the day every deployment stops updating.
 *   - **It always dies.** Every exit path goes through `stop()`, which escalates from SIGTERM to
 *     SIGKILL, so a candidate that ignores signals or hangs in shutdown cannot outlive the check
 *     and sit on the snapshot it was given.
 *   - **Its output is bounded.** A candidate stuck in a logging loop must not be able to fill the
 *     updater's memory; head and tail are kept, and the gap is stated rather than hidden.
 *
 * The first use of `node:child_process` in the tree. That is deliberate and confined to the
 * updater, which is not the mail server (ADR 0025) — the zero-dependency claim is about what
 * answers port 25.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export class CandidateError extends Error {}

/** Head and tail kept from the child's output; anything between is elided with a count. */
const OUTPUT_HEAD_BYTES = 96 * 1024;
const OUTPUT_TAIL_BYTES = 32 * 1024;
const SIGKILL_GRACE_MS = 10_000;

export interface CandidatePorts {
  readonly smtp: number;
  readonly submission: number;
  readonly imap: number;
}

export interface RunningCandidate {
  readonly ports: CandidatePorts;
  /** How long from spawn to all three listeners accepting — schema migration included. */
  readonly readyMs: number;
  /** Everything the child wrote, bounded. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Reserve three free loopback ports.
 *
 * All three are held open until every one has been chosen, so they cannot collide with each other.
 * There is still a window between closing them and the child binding them, in which something else
 * on the machine could take one; that shows up as a boot failure, which the caller retries. Asking
 * the child to bind port 0 would close the window, but the port would then be known only to the
 * child, and this process needs the numbers to probe and to run the conformance suite against.
 */
async function reservePorts(): Promise<CandidatePorts> {
  const servers: net.Server[] = [];
  const ports: number[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new CandidateError('could not reserve a loopback port');
      ports.push(address.port);
    }
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
  return { smtp: ports[0]!, submission: ports[1]!, imap: ports[2]! };
}

/** Does something accept a TCP connection on this port right now? */
function accepts(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (answer: boolean): void => {
      sock.destroy();
      resolve(answer);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Accumulates child output, keeping the head and the tail and counting what it dropped. */
class BoundedOutput {
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  #dropped = 0;

  push(chunk: Buffer): void {
    if (this.#headBytes < OUTPUT_HEAD_BYTES) {
      this.#head.push(chunk);
      this.#headBytes += chunk.length;
      return;
    }
    this.#tail.push(chunk);
    this.#tailBytes += chunk.length;
    while (this.#tailBytes > OUTPUT_TAIL_BYTES && this.#tail.length > 1) {
      this.#dropped += this.#tail[0]!.length;
      this.#tailBytes -= this.#tail.shift()!.length;
    }
  }

  toString(): string {
    const head = Buffer.concat(this.#head).toString('utf8');
    if (this.#tail.length === 0) return head;
    return `${head}\n...[${this.#dropped} bytes of output elided]...\n${Buffer.concat(this.#tail).toString('utf8')}`;
  }
}

export interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly ms: number;
}

/**
 * Run a command to completion under a deadline, killing its whole process group on timeout.
 *
 * The process group is the point. A candidate's test suite spawns children of its own — integration
 * tests that start servers, workload processes — and killing only the runner would leave those
 * holding ports and temporary files after the pre-flight believed it had cleaned up. `detached`
 * puts the child in its own group so one `kill(-pid)` reaches all of it.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env: Record<string, string>; readonly timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const output = new BoundedOutput();
    child.stdout?.on('data', (d: Buffer) => output.push(d));
    child.stderr?.on('data', (d: Buffer) => output.push(d));

    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone, or never grouped: nothing to do.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), SIGKILL_GRACE_MS).unref();
    }, opts.timeoutMs);

    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, output: `failed to start: ${String(e)}`, ms: Date.now() - started });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output: output.toString(), ms: Date.now() - started });
    });
  });
}

export interface StartCandidateOptions {
  /** The checkout to run. `src/main.ts` inside it is the entry point. */
  readonly dir: string;
  /** The complete environment for the child. Nothing is inherited implicitly. */
  readonly env: Record<string, string>;
  /** How long to wait for all three listeners before giving up. */
  readonly readyTimeoutMs: number;
  /** How long a candidate gets to honour SIGTERM before SIGKILL. Tests shorten it. */
  readonly killGraceMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * Start a candidate and wait until it is serving.
 *
 * Rejects — having killed the child — if it exits early, if it never listens, or if it listens on
 * fewer than three ports. A partially-started mail server is not a working one: a daemon that
 * answers submission but not IMAP would pass a laxer check and then fail every client.
 */
export async function startCandidate(opts: StartCandidateOptions): Promise<RunningCandidate> {
  const ports = await reservePorts();
  const env: Record<string, string> = {
    ...opts.env,
    MAIL_HOST: '127.0.0.1',
    MAIL_SMTP_PORT: String(ports.smtp),
    MAIL_SUBMISSION_PORT: String(ports.submission),
    MAIL_IMAP_PORT: String(ports.imap),
  };

  // Resolve symlinks before spawning. `main.ts` decides whether it is the program by comparing
  // `import.meta.url`, which has symlinks resolved, against `process.argv[1]`, which does not — so
  // handing it a path through a symlink (a `/opt` that is really a mount, a temporary directory on
  // macOS) makes it load, decide it is being imported, and exit 0 having done nothing. That failure
  // is silent: no output, no error, just a daemon that is not there.
  const dir = realpathSync(opts.dir);
  const started = Date.now();
  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(dir, 'src', 'main.ts')],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const output = new BoundedOutput();
  child.stdout?.on('data', (d: Buffer) => output.push(d));
  child.stderr?.on('data', (d: Buffer) => output.push(d));

  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (exit !== null) return;
    child.kill('SIGTERM');
    // A candidate that ignores SIGTERM, or wedges in shutdown, must not outlive the check and keep
    // its snapshot open. Escalate rather than wait indefinitely.
    const killed = await Promise.race([exited.then(() => true), delay(opts.killGraceMs ?? SIGKILL_GRACE_MS).then(() => false)]);
    if (!killed) {
      opts.log?.('candidate did not exit on SIGTERM; sending SIGKILL');
      child.kill('SIGKILL');
      await exited;
    }
  };

  const deadline = Date.now() + opts.readyTimeoutMs;
  try {
    for (;;) {
      if (exit !== null) {
        const e = exit as { code: number | null; signal: NodeJS.Signals | null };
        throw new CandidateError(
          `the candidate exited before it was serving (code ${String(e.code)}, signal ${String(e.signal)}).\n${output.toString()}`,
        );
      }
      const ready = await Promise.all([accepts(ports.smtp, 1000), accepts(ports.submission, 1000), accepts(ports.imap, 1000)]);
      if (ready.every(Boolean)) break;
      if (Date.now() > deadline) {
        const which = ['inbound', 'submission', 'imap'].filter((_, i) => !ready[i]);
        throw new CandidateError(
          `the candidate did not start serving within ${opts.readyTimeoutMs}ms (not listening: ${which.join(', ')}).\n${output.toString()}`,
        );
      }
      await delay(100);
    }
  } catch (e) {
    await stop();
    throw e;
  }

  return { ports, readyMs: Date.now() - started, output: () => output.toString(), stop };
}
