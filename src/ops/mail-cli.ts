/**
 * `mail` — read a delivered mailbox from the operator CLI.
 *
 * The only read path was a full IMAPS client, so the everyday operator/CI question —
 * "did it arrive, and what was the subject" — needed an IMAP library or a hand-rolled
 * openssl script. This is the read-only counterpart of `dead-letter show`, with the same
 * trust model (local operator, direct database access) and the same --raw contract
 * (byte-exact .eml to a non-TTY):
 *
 *   mail list <login> [--mailbox NAME]        uid, date, size, flags, from, subject
 *   mail show <login> <uid> [--mailbox NAME]  metadata + headers (--raw streams the bytes)
 *
 * Strictly read-only: it never creates a database (a typo'd path is an error, not a fresh
 * empty store) and never mutates flags — reading here does not mark anything \Seen.
 */

import { existsSync } from 'node:fs';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import type { OpsIo } from './cli.ts';
import { sanitizeForTerminal, sanitizeForTerminalLine } from './terminal.ts';

const USAGE = [
  'usage: node src/main.ts mail <list|show> <login> [uid] [--mailbox NAME] [--raw] [--db <control.db>]',
  '',
  'Read a delivered mailbox directly (read-only; nothing is marked as seen):',
  '  list <login>        every message in the mailbox (default INBOX): uid, date,',
  '                      size, flags, From and Subject',
  '  show <login> <uid>  metadata and headers; --raw streams the complete message to',
  '                      stdout (redirect to a file to get a .eml)',
  '',
  'The control database is MAIL_CONTROL_DB or --db.',
].join('\n');

const iso = (ms: number): string => (ms === 0 ? '(no date)' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

/** First value of a header (folded continuation lines unfolded), or undefined. */
function headerValue(headers: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:[ \\t]*(.*(?:\\r\\n[ \\t].*)*)`, 'im');
  const m = re.exec(headers);
  return m?.[1]?.replace(/\r\n[ \t]+/g, ' ');
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function runMail(
  args: string[],
  io: OpsIo,
  env: Record<string, string | undefined>,
  writeBytes: (b: Buffer) => void = (b) => void process.stdout.write(b),
  isTty: boolean = process.stdout.isTTY === true,
): number {
  const positional: string[] = [];
  let dbPath = env.MAIL_CONTROL_DB ?? 'control.db';
  let mailboxName = 'INBOX';
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--db') dbPath = args[++i] ?? dbPath;
    else if (a === '--mailbox') mailboxName = args[++i] ?? mailboxName;
    else if (a === '--raw') raw = true;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      io.err(`mail: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    } else positional.push(a);
  }
  const [verb, login, uidArg] = positional;
  if (verb !== 'list' && verb !== 'show') {
    io.err(USAGE);
    return 2;
  }
  if (login === undefined) {
    io.err(`mail ${verb}: a login is required.`);
    return 2;
  }
  if (dbPath !== ':memory:' && !existsSync(dbPath)) {
    io.err(`control database ${dbPath} does not exist (set MAIL_CONTROL_DB or --db).`);
    return 2;
  }

  const controlDb = openMailDb(dbPath);
  let account;
  try {
    account = AccountRegistry.open(controlDb).lookup(login);
  } finally {
    controlDb.close();
  }
  if (account === undefined) {
    io.err(`mail ${verb}: no account "${login}" in ${dbPath}.`);
    return 1;
  }
  if (account.mailDbPath === ':memory:') {
    io.err(`mail ${verb}: ${login}'s mailbox is in-memory: it exists only inside the running daemon and cannot be read from a second process.`);
    return 1;
  }
  if (!existsSync(account.mailDbPath)) {
    io.out(`mail ${verb}: ${login} has no mailbox database yet (${account.mailDbPath}): nothing has ever been delivered.`);
    return verb === 'list' ? 0 : 1;
  }

  const db = openMailDb(account.mailDbPath);
  try {
    const catalog = SqliteCatalog.open(db);
    const box = catalog.get(mailboxName);
    if (box === undefined) {
      io.err(sanitizeForTerminalLine(`mail ${verb}: no mailbox "${mailboxName}" for ${login} (have: ${catalog.listNames().join(', ')}).`));
      return 1;
    }

    if (verb === 'list') {
      const index = box.index();
      for (const m of index) {
        const rawBytes = box.raw(m.uid);
        const sep = rawBytes?.indexOf(Buffer.from('\r\n\r\n', 'latin1')) ?? -1;
        const headers = rawBytes === undefined ? '' : (sep === -1 ? rawBytes : rawBytes.subarray(0, sep)).toString('latin1');
        const from = headerValue(headers, 'From') ?? '(no From)';
        const subject = headerValue(headers, 'Subject') ?? '(no subject)';
        const flags = [...m.flags].join(',');
        io.out(sanitizeForTerminalLine(`${String(m.uid).padStart(5)}  ${iso(m.internalDate)}  ${String(m.size).padStart(8)}  ${(flags === '' ? '-' : flags).padEnd(12)}  ${clip(from, 30).padEnd(30)}  ${clip(subject, 60)}`));
      }
      io.out(index.length === 0 ? `${mailboxName} of ${login}: empty` : `${mailboxName} of ${login}: ${index.length} message(s)${account.enabled ? '' : ' (account is DISABLED)'}`);
      const others = catalog
        .listNames()
        .filter((n) => n !== mailboxName)
        .map((n) => ({ n, count: catalog.get(n)?.index().length ?? 0 }))
        .filter((x) => x.count > 0);
      if (others.length > 0) io.out(sanitizeForTerminalLine(`other mailboxes with mail: ${others.map((x) => `${x.n} (${x.count})`).join(', ')}`));
      return 0;
    }

    // show
    if (uidArg === undefined || !/^\d+$/.test(uidArg)) {
      io.err('usage: mail show <login> <uid> [--mailbox NAME] [--raw]');
      return 2;
    }
    const uid = Number(uidArg);
    const bytes = box.raw(uid);
    if (bytes === undefined) {
      io.err(`mail show: no message with uid ${uid} in ${mailboxName} of ${login} (see \`mail list ${login}\`).`);
      return 1;
    }
    if (raw) {
      // Byte-exact .eml — same TTY refusal as dead-letter show --raw: message bytes are
      // attacker-controlled and may carry terminal escapes.
      if (isTty) {
        io.err('mail show --raw writes the exact message bytes to stdout; refusing to write to a terminal. Redirect to a file, e.g. `... --raw > message.eml`.');
        return 2;
      }
      writeBytes(bytes);
      return 0;
    }
    const meta = box.index().find((m) => m.uid === uid);
    if (meta !== undefined) {
      io.out(sanitizeForTerminalLine(`uid=${meta.uid} date=${iso(meta.internalDate)} size=${meta.size} flags=${[...meta.flags].join(',') || '-'}`));
      io.out('');
    }
    const sep = bytes.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
    const headers = sep === -1 ? bytes : bytes.subarray(0, sep);
    io.out(sanitizeForTerminal(headers.toString('latin1')));
    io.out('');
    io.out(`(headers only, full ${bytes.length}-byte message: mail show ${login} ${uid} --raw)`);
    return 0;
  } finally {
    db.close();
  }
}
