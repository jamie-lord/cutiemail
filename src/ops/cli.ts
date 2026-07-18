/**
 * The operator CLI dispatch — `node src/main.ts <command>` (docs/BACKLOG.md).
 *
 * One entry point, mox-style: with no argument main.ts runs the daemon; with a
 * command it runs an operator tool against the same environment configuration.
 * Commands live in their own modules; this is only the routing and the IO seam
 * (injected so tests capture output exactly).
 *
 * Exit codes follow the conformance CLI's convention: 0 success, 1 a real
 * finding/failure the command detected, 2 usage or configuration error.
 */

import { runSetup } from './setup.ts';
import { runDoctor } from './doctor.ts';
import { runAccount } from './account.ts';
import { runBackup, runVerify } from './backup.ts';

export interface OpsIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'usage: node src/main.ts [command]',
  '',
  'With no command, runs the mail server daemon. Commands:',
  '  setup    generate the DKIM key (if missing) and print the DNS records to publish',
  '  doctor   check the deployment against live DNS and the network (drift, cert, port 25)',
  '  account  add/list accounts, change passwords, enable/disable — no passwords in env',
  '  backup   consistent online snapshot of every database into a directory',
  '  verify   integrity + store-invariant check of database files (read-only)',
  '  help     this text',
].join('\n');

export async function runOps(argv: readonly string[], io: OpsIo, env: Record<string, string | undefined>): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'setup':
      return runSetup(rest, io, env);
    case 'doctor':
      return runDoctor(rest, io, env);
    case 'account':
      return runAccount(rest, io, env);
    case 'backup':
      return runBackup(rest, io, env);
    case 'verify':
      return runVerify(rest, io);
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    default:
      io.err(`unknown command: ${String(cmd)}`);
      io.err(USAGE);
      return 2;
  }
}
