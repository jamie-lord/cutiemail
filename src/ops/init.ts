/**
 * `node src/main.ts init <login>` — the guided, passwordless first run.
 *
 * The credential registry stores only SCRAM keys (never a password), but the ONE
 * remaining way a plaintext password used to reach a deployment was the bootstrap
 * env vars (MAIL_USER/MAIL_PASS/MAIL_ACCOUNTS) sitting forever in the systemd unit
 * and /proc/<pid>/environ (ADR 0012). `init` closes that: it creates the first
 * account by writing SCRAM straight to the control database from a hidden prompt,
 * then prints how to run the daemon with NO password anywhere in the environment.
 *
 * It is deliberately a first-run-only command: if the registry already has any
 * account it refuses and points at `account add`, so it can never clobber an
 * existing deployment. Everything after the first account is ordinary `account`.
 */

import { join, dirname } from 'node:path';
import type { OpsIo } from './cli.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { validLogin, readNewPassword, passwordPolicyError, stdinPasswordSource, type PasswordSource } from './account.ts';

const USAGE = [
  'usage: node src/main.ts init <login> [--db <control.db>]',
  '',
  'Create the FIRST account (passwordless bootstrap): prompts for the password',
  '(twice, hidden), writes SCRAM credentials to the control database, and prints',
  'how to run the daemon with no password in the environment. Refuses if any',
  'account already exists — use `account add` for the rest.',
].join('\n');

export async function runInit(
  args: string[],
  io: OpsIo,
  env: Record<string, string | undefined>,
  source: PasswordSource = stdinPasswordSource(),
): Promise<number> {
  const positional: string[] = [];
  let dbPath = env.MAIL_CONTROL_DB ?? 'control.db';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--db') dbPath = args[++i] ?? dbPath;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      io.err(`init: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    } else positional.push(a);
  }
  const login = positional[0];
  if (login === undefined || !validLogin(login)) {
    io.err('init: a login is required — letters/digits then letters/digits/._- (max 64); it names the mailbox database file.');
    io.err(USAGE);
    return 2;
  }

  const db = openMailDb(dbPath);
  try {
    const registry = AccountRegistry.open(db);
    const existing = registry.list();
    if (existing.length > 0) {
      io.err(`init: already initialised (${existing.length} account(s) exist) — use \`account add ${login}\` to add another, or \`account list\` to see them.`);
      return 1;
    }
    const password = await readNewPassword(source);
    if (password === null) {
      io.err('init: empty password or the two entries did not match — nothing created.');
      return 1;
    }
    const policyErr = passwordPolicyError(password);
    if (policyErr !== null) {
      io.err(`init: ${policyErr}`);
      return 1;
    }
    const mailDbPath = dbPath === ':memory:' ? ':memory:' : join(dirname(dbPath), `mail-${login}.db`);
    registry.upsert(login, password, mailDbPath);

    const domain = env.MAIL_DOMAIN ?? 'mail.example.com';
    io.out(`account ${login} created — the control database is now the source of truth for credentials.`);
    io.out('');
    io.out('Run the daemon with NO password in the environment. A minimal unit:');
    io.out('');
    io.out('  [Service]');
    io.out('  ExecStart=/usr/bin/node src/main.ts');
    io.out(`  Environment=MAIL_DOMAIN=${domain}`);
    io.out('  Environment=MAIL_HOST=0.0.0.0');
    io.out(`  Environment=MAIL_CONTROL_DB=${dbPath}`);
    io.out('  Environment=MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem');
    io.out('  Environment=MAIL_TLS_KEY=/var/lib/mailserver/tls/key.pem');
    io.out('  # No MAIL_USER / MAIL_PASS / MAIL_ACCOUNTS — the registry holds the credentials.');
    io.out('');
    io.out(`Add more accounts with \`account add <login>\`; change this one with \`account set-password ${login}\`.`);
    io.out('The running daemon picks all of these up immediately — no restart needed.');
    return 0;
  } finally {
    db.close();
  }
}
