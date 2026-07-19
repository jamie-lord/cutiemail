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
  '  list                  every account, its state, mailbox database, and aliases',
  '  alias add <login> <local-part>   route another address to that account (ADR 0014)',
  '  alias remove <local-part>        remove an alias',
  '  alias list [login]               every alias (or one account\'s)',
  '',
  'The control database is MAIL_CONTROL_DB (default control.db), or --db.',
  'When stdin is not a terminal, the password is read as one line from stdin.',
].join('\n');

/** `account alias add|remove|list` — aliases are routing, not identity (ADR 0014). */
function runAlias(args: readonly string[], io: OpsIo, registry: AccountRegistry): number {
  const [sub, arg1, arg2] = args;
  switch (sub) {
    case 'add': {
      const login = arg1;
      const local = arg2;
      if (login === undefined || local === undefined) {
        io.err('usage: account alias add <login> <local-part>  (e.g. account alias add jamie sales)');
        return 2;
      }
      if (local.includes('@')) {
        io.err(`alias add: give the local-part only (e.g. sales), not the full address — the domain is the server's MAIL_DOMAIN.`);
        return 2;
      }
      if (!validLogin(local)) {
        io.err(`alias add: "${local}" is not a valid address local-part — letters/digits then letters/digits/._- (no '+', which is reserved for subaddressing).`);
        return 2;
      }
      if (registry.lookup(login) === undefined) {
        io.err(`alias add: no account "${login}" — create it first with \`account add ${login}\`.`);
        return 1;
      }
      const taken = registry.nameTaken(local);
      if (taken !== undefined) {
        io.err(`alias add: "${local}" is already a ${taken} — an address resolves to one account.`);
        return 1;
      }
      registry.addAlias(local, login);
      io.out(`alias ${local.toLowerCase()} -> ${login} added. The running daemon delivers to it immediately — no restart.`);
      return 0;
    }
    case 'remove': {
      const local = arg1;
      if (local === undefined) {
        io.err('usage: account alias remove <local-part>');
        return 2;
      }
      if (!registry.removeAlias(local)) {
        io.err(`alias remove: no alias "${local.toLowerCase()}".`);
        return 1;
      }
      io.out(`alias ${local.toLowerCase()} removed.`);
      return 0;
    }
    case 'list': {
      const login = arg1;
      if (login !== undefined && registry.lookup(login) === undefined) {
        io.err(`alias list: no account "${login}".`);
        return 1;
      }
      const rows = login !== undefined ? registry.aliasesFor(login).map((alias) => ({ alias, login })) : registry.allAliases();
      if (rows.length === 0) io.out(login !== undefined ? `no aliases for ${login}.` : 'no aliases.');
      for (const r of rows) io.out(`${r.alias.padEnd(24)} -> ${r.login}`);
      return 0;
    }
    default:
      io.err('usage: account alias add <login> <local-part> | remove <local-part> | list [login]');
      return 2;
  }
}

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
export function stdinPasswordSource(): PasswordSource {
  return { interactive: process.stdin.isTTY === true, read: promptSecret };
}

/** One read piped, two matching reads interactive; empty is always refused. */
export async function readNewPassword(source: PasswordSource): Promise<string | null> {
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
  // 'list' takes no login; 'alias' parses its own sub-arguments (see runAlias).
  const needsLogin = verb !== 'list' && verb !== 'alias';
  if (needsLogin && (login === undefined || !validLogin(login))) {
    io.err(`account ${verb}: a login is required — letters/digits then letters/digits/._- (max 64); it names the mailbox database file.`);
    return 2;
  }

  const db = openMailDb(dbPath);
  try {
    const registry = AccountRegistry.open(db);
    switch (verb) {
      case 'alias':
        return runAlias(positional.slice(1), io, registry);
      case 'add': {
        if (registry.lookup(login!) !== undefined) {
          io.err(`account add: ${login} already exists — use set-password to change its password.`);
          return 1;
        }
        // A login and an alias share one namespace — an address resolves to one account
        // (ADR 0014). Refuse a login that an alias already claims.
        if (registry.nameTaken(login!) === 'alias') {
          io.err(`account add: "${login}" is already an alias — remove it first (\`account alias remove ${login}\`) or pick another login.`);
          return 1;
        }
        // Reject a login that case-folds to an existing one: it maps to the same
        // mail-<login>.db file on a case-insensitive filesystem (macOS default, some container
        // volumes), silently sharing one mailbox between two distinct-credential accounts
        // (audit run-4). Logins must be unique regardless of case.
        const lc = login!.toLowerCase();
        const clash = registry.list().find((a) => a.login.toLowerCase() === lc);
        if (clash !== undefined) {
          io.err(`account add: ${login} collides with existing account "${clash.login}" (case-insensitive) — logins must be unique regardless of case.`);
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
        for (const r of rows) {
          const aliases = registry.aliasesFor(r.login);
          const suffix = aliases.length > 0 ? `  aliases: ${aliases.join(', ')}` : '';
          io.out(`${r.enabled ? 'enabled ' : 'DISABLED'}  ${r.login.padEnd(16)} ${r.mailDbPath}${suffix}`);
        }
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
