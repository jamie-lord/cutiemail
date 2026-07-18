/**
 * `account` — provision accounts without passwords in the environment (backlog B3).
 *
 * The SCRAM registry was designed to store only StoredKey/ServerKey, never the
 * password — but until now every boot re-fed plaintext passwords through
 * MAIL_USER/MAIL_PASS/MAIL_ACCOUNTS, which means they live forever in the systemd
 * unit file. This command writes the registry directly, so the unit file needs no
 * passwords at all (ADR 0012: the registry is the source of truth; env vars only
 * seed accounts that don't exist yet).
 *
 * Verbs: add, set-password, enable, disable, list. There is deliberately no
 * `remove`: deleting the registry row would only discard the salt/keys while the
 * user's mail-<login>.db remained on disk — a half-destruction that pretends to be
 * clean. `disable` refuses auth and delivery, is reversible, and destroys nothing;
 * actually deleting a user's mail is a deliberate `rm` of their database file.
 *
 * Passwords are read from a prompt (or stdin when piped), NEVER from argv — argv
 * is visible to every process on the machine via `ps`.
 *
 * The daemon picks changes up live: auth and delivery consult the registry per
 * operation, so an account added while the server runs works immediately, no
 * restart (WAL: the CLI writer never blocks the daemon's readers).
 */

import { dirname, join } from 'node:path';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import type { OpsIo } from './cli.ts';

/**
 * A login must be safe as a local-part AND as a filename fragment — it becomes
 * `mail-<login>.db` on disk, so path metacharacters are refused outright, as are
 * the delimiters of the MAIL_ACCOUNTS env format and the address separator.
 */
export function validLogin(login: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(login) && !login.includes('..');
}

const USAGE = [
  'usage: node src/main.ts account <verb> [login] [--db <control.db>]',
  '',
  'Manage accounts in the control database (no passwords in the environment):',
  '  add <login>           create an account (prompts for the password twice)',
  '  set-password <login>  change a password (prompts twice)',
  '  disable <login>       refuse auth + inbound delivery for the account (reversible;',
  '                        the mailbox database is never touched)',
  '  enable <login>        re-enable a disabled account',
  '  list                  every account, its state, and its mailbox database',
  '',
  'The control database is MAIL_CONTROL_DB (default control.db), or --db.',
  'When stdin is not a terminal, the password is read as one line from stdin.',
].join('\n');

/**
 * Where passwords come from. `interactive` decides whether a confirmation prompt
 * makes sense: a human typing blind needs to type it twice (a typo'd password you
 * can't see is forever); a piped line has no typo problem and gets exactly one
 * read — `echo "pw" | ... account add u` must work as documented.
 */
export interface PasswordSource {
  readonly interactive: boolean;
  read(promptText: string): Promise<string>;
}

/** Hidden-input password prompt: no echo on a TTY, one line from stdin otherwise. */
export async function promptSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped: read one line (scripting / tests). The trailing newline is not part
    // of the password.
    return await new Promise<string>((res, rej) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer): void => {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(0x0a);
        if (nl !== -1) {
          stdin.off('data', onData);
          stdin.pause();
          res(buf.subarray(0, nl).toString('utf8').replace(/\r$/, ''));
        }
      };
      stdin.on('data', onData);
      stdin.once('end', () => res(buf.toString('utf8').replace(/\r?\n?$/, '')));
      stdin.once('error', rej);
    });
  }
  process.stderr.write(promptText);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((res, rej) => {
      let entered = '';
      const onData = (d: Buffer): void => {
        for (const byte of d) {
          if (byte === 0x0d || byte === 0x0a) {
            stdin.off('data', onData);
            process.stderr.write('\n');
            res(entered);
            return;
          }
          if (byte === 0x03) {
            // Ctrl-C
            stdin.off('data', onData);
            process.stderr.write('\n');
            rej(new Error('interrupted'));
            return;
          }
          if (byte === 0x7f || byte === 0x08) entered = entered.slice(0, -1);
          else entered += String.fromCharCode(byte);
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** The real source: hidden TTY prompt (with confirmation) or one line of stdin. */
function stdinPasswordSource(): PasswordSource {
  return { interactive: process.stdin.isTTY === true, read: promptSecret };
}

/** One read piped, two matching reads interactive; empty is always refused. */
async function readNewPassword(source: PasswordSource): Promise<string | null> {
  const first = await source.read('password: ');
  if (first === '') return null;
  if (!source.interactive) return first;
  const second = await source.read('again: ');
  return first === second ? first : null;
}

export async function runAccount(
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
      io.err(`account: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    } else positional.push(a);
  }
  const [verb, login] = positional;
  if (verb === undefined) {
    io.err(USAGE);
    return 2;
  }
  const needsLogin = verb !== 'list';
  if (needsLogin && (login === undefined || !validLogin(login))) {
    io.err(`account ${verb}: a login is required — letters/digits then letters/digits/._- (max 64); it names the mailbox database file.`);
    return 2;
  }

  const db = openMailDb(dbPath);
  try {
    const registry = AccountRegistry.open(db);
    switch (verb) {
      case 'add': {
        if (registry.lookup(login!) !== undefined) {
          io.err(`account add: ${login} already exists — use set-password to change its password.`);
          return 1;
        }
        const password = await readNewPassword(source);
        if (password === null) {
          io.err('account add: empty password or the two entries did not match — nothing created.');
          return 1;
        }
        const mailDbPath = dbPath === ':memory:' ? ':memory:' : join(dirname(dbPath), `mail-${login}.db`);
        registry.upsert(login!, password, mailDbPath);
        io.out(`account ${login} created (mailbox database: ${mailDbPath}).`);
        io.out('The running daemon picks this up immediately — no restart needed.');
        return 0;
      }
      case 'set-password': {
        const existing = registry.lookup(login!);
        if (existing === undefined) {
          io.err(`account set-password: ${login} does not exist — use add.`);
          return 1;
        }
        const password = await readNewPassword(source);
        if (password === null) {
          io.err('account set-password: empty password or the two entries did not match — unchanged.');
          return 1;
        }
        // Preserve the routing and state; only the credential changes.
        registry.upsert(login!, password, existing.mailDbPath, { enabled: existing.enabled });
        io.out(`account ${login}: password changed.`);
        return 0;
      }
      case 'enable':
      case 'disable': {
        if (registry.lookup(login!) === undefined) {
          io.err(`account ${verb}: ${login} does not exist.`);
          return 1;
        }
        registry.setEnabled(login!, verb === 'enable');
        io.out(`account ${login}: ${verb}d.${verb === 'disable' ? ' Auth and inbound delivery now refuse it; the mailbox database is untouched.' : ''}`);
        return 0;
      }
      case 'list': {
        const rows = registry.list();
        if (rows.length === 0) io.out('no accounts.');
        for (const r of rows) io.out(`${r.enabled ? 'enabled ' : 'DISABLED'}  ${r.login.padEnd(16)} ${r.mailDbPath}`);
        return 0;
      }
      default:
        io.err(`account: unknown verb ${verb}`);
        io.err(USAGE);
        return 2;
    }
  } finally {
    db.close();
  }
}
