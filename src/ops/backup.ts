/**
 * `backup` + `verify` — the SQLite payoff (backlog B4).
 *
 * The whole server's state is n SQLite files: the control database (accounts +
 * outbound queue + dead letters) and one mailbox database per user. `backup`
 * snapshots all of them with SQLite's own `VACUUM INTO` — a transactionally
 * consistent copy even while the daemon is writing (WAL readers don't block
 * writers), which a naive `cp` of a live WAL database is NOT. `verify` proves a
 * backup (or the live files) is actually restorable: `PRAGMA integrity_check`
 * plus the cross-table invariants the crash/concurrency suites establish —
 * because a backup you've never verified is a hope, not a backup.
 *
 * `verify` opens strictly READ-ONLY: verifying a backup must never mutate it
 * (Mox's verifydata warns it auto-upgrades schemas; we hold a harder line).
 *
 * Honest detection boundary: SQLite pages carry NO checksums, so
 * integrity_check catches structural corruption (broken pages, b-trees,
 * indexes) and the invariant queries catch semantic corruption — but a bit
 * flipped inside a message blob's payload is invisible to both. End-to-end
 * payload assurance is what filesystem/media checksums (ZFS, btrfs, restic)
 * are for; claiming it here would be a false promise.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import type { OpsIo } from './cli.ts';

/** SQL string-literal escape for the VACUUM INTO target path. */
const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Snapshot one database into destPath via VACUUM INTO (fails if destPath exists). */
export function snapshotDatabase(sourcePath: string, destPath: string): void {
  const db = openMailDb(sourcePath);
  try {
    db.exec(`VACUUM INTO ${sqlString(destPath)}`);
    // The snapshot is a byte-exact copy of the source's secrets (SCRAM material + raw mail) —
    // make it private explicitly, not only via the caller's umask.
    chmodSync(destPath, 0o600);
  } finally {
    db.close();
  }
}

export interface VerifyReport {
  readonly path: string;
  readonly kind: 'control' | 'mail' | 'unrecognized';
  readonly findings: readonly string[]; // empty = healthy
}

/** Table names present in a database. */
function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number | bigint }).c);

/**
 * Verify one database file, read-only. The invariants mirror what the crash and
 * concurrency suites prove about a healthy store:
 *   mail:    every live/expunged UID < its mailbox's uid_next (monotonic UID
 *            allocation); no orphaned message/flag rows; no UID both live and
 *            expunged (the partition invariant).
 *   control: no message both queued and dead-lettered (the transactional-move
 *            invariant); account rows structurally sound; recipient lists are
 *            non-empty JSON string arrays.
 */
export function verifyDatabase(path: string): VerifyReport {
  const findings: string[] = [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    return { path, kind: 'unrecognized', findings: [`cannot open: ${String(e)}`] };
  }
  try {
    let integrity: Array<{ integrity_check: string }>;
    try {
      integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    } catch (e) {
      // Not a SQLite file at all — the open is lazy, the first statement throws.
      return { path, kind: 'unrecognized', findings: [`not a readable database: ${String(e)}`] };
    }
    if (!(integrity.length === 1 && integrity[0]!.integrity_check === 'ok')) {
      return { path, kind: 'unrecognized', findings: integrity.map((r) => `integrity: ${r.integrity_check}`) };
    }

    const tables = tableNames(db);
    if (tables.has('mailbox') && tables.has('message')) {
      const beyond = count(db, 'SELECT COUNT(*) c FROM message m JOIN mailbox b ON m.mailbox_id = b.id WHERE m.uid >= b.uid_next');
      if (beyond > 0) findings.push(`${beyond} message(s) with uid >= their mailbox's uid_next — UID allocation is broken`);
      const expBeyond = count(db, 'SELECT COUNT(*) c FROM expunged e JOIN mailbox b ON e.mailbox_id = b.id WHERE e.uid >= b.uid_next');
      if (expBeyond > 0) findings.push(`${expBeyond} expunge-log entry(ies) with uid >= uid_next`);
      const orphanMsg = count(db, 'SELECT COUNT(*) c FROM message WHERE mailbox_id NOT IN (SELECT id FROM mailbox)');
      if (orphanMsg > 0) findings.push(`${orphanMsg} message(s) in a nonexistent mailbox`);
      const orphanFlag = count(db, 'SELECT COUNT(*) c FROM flag f WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.mailbox_id = f.mailbox_id AND m.uid = f.uid)');
      if (orphanFlag > 0) findings.push(`${orphanFlag} flag(s) on a nonexistent message`);
      const both = count(db, 'SELECT COUNT(*) c FROM message m JOIN expunged e ON e.mailbox_id = m.mailbox_id AND e.uid = m.uid');
      if (both > 0) findings.push(`${both} uid(s) both live and expunged — the partition invariant is violated`);
      return { path, kind: 'mail', findings };
    }

    if (tables.has('accounts') || tables.has('outbound_queue')) {
      if (tables.has('accounts')) {
        const badAccounts = count(
          db,
          'SELECT COUNT(*) c FROM accounts WHERE enabled NOT IN (0,1) OR iterations <= 0 OR length(salt) = 0 OR length(stored_key) = 0 OR length(server_key) = 0',
        );
        if (badAccounts > 0) findings.push(`${badAccounts} structurally unsound account row(s)`);
      }
      if (tables.has('outbound_queue') && tables.has('dead_letter')) {
        const both = count(db, 'SELECT COUNT(*) c FROM outbound_queue q JOIN dead_letter d ON d.id = q.id');
        if (both > 0) findings.push(`${both} message(s) BOTH queued and dead-lettered — the transactional move is broken`);
      }
      for (const table of ['outbound_queue', 'dead_letter']) {
        if (!tables.has(table)) continue;
        const rows = db.prepare(`SELECT id, recipients FROM ${table}`).all() as Array<{ id: string; recipients: string }>;
        for (const r of rows) {
          try {
            const parsed: unknown = JSON.parse(r.recipients);
            if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((x) => typeof x !== 'string')) {
              findings.push(`${table} ${r.id}: recipients is not a non-empty string array`);
            }
          } catch {
            findings.push(`${table} ${r.id}: recipients is not valid JSON`);
          }
        }
      }
      return { path, kind: 'control', findings };
    }

    return { path, kind: 'unrecognized', findings: ['unrecognized schema — not a cutiemail database'] };
  } finally {
    db.close();
  }
}

const BACKUP_USAGE = [
  'usage: node src/main.ts backup <destdir> [--db <control.db>]',
  '',
  'Consistent online snapshot (VACUUM INTO) of the control database and every',
  "account's mailbox database into <destdir>. Safe while the daemon runs; never",
  'overwrites an existing file. The control database is MAIL_CONTROL_DB or --db.',
].join('\n');

export function runBackup(args: string[], io: OpsIo, env: Record<string, string | undefined>): number {
  let dbPath = env.MAIL_CONTROL_DB ?? 'control.db';
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--db') dbPath = args[++i] ?? dbPath;
    else if (a === '--help' || a === '-h') {
      io.out(BACKUP_USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      io.err(`backup: unknown argument ${a}`);
      io.err(BACKUP_USAGE);
      return 2;
    } else positional.push(a);
  }
  const destDir = positional[0];
  if (destDir === undefined || positional.length !== 1) {
    io.err(BACKUP_USAGE);
    return 2;
  }
  if (!existsSync(dbPath)) {
    io.err(`backup: control database ${dbPath} does not exist (set MAIL_CONTROL_DB or --db).`);
    return 2;
  }
  mkdirSync(destDir, { recursive: true, mode: 0o700 }); // the backup dir holds copies of all secrets

  // The control DB names every mailbox database — that enumeration is the backup
  // manifest. Missing mailbox files are accounts that never received mail (their
  // database is created lazily); noted, not fatal.
  const controlDb = openMailDb(dbPath);
  const accounts = AccountRegistry.open(controlDb).list();
  controlDb.close();

  const sources: Array<{ source: string; label: string }> = [{ source: dbPath, label: 'control' }];
  for (const a of accounts) {
    if (a.mailDbPath === ':memory:') continue;
    sources.push({ source: a.mailDbPath, label: a.login });
  }
  const usedNames = new Set<string>();
  let copied = 0;
  for (const { source, label } of sources) {
    const name = basename(source);
    if (usedNames.has(name)) {
      io.err(`backup: two databases share the file name ${name} — refusing an ambiguous backup.`);
      return 1;
    }
    usedNames.add(name);
    if (!existsSync(source)) {
      io.out(`  --    ${label}: ${source} not created yet (no mail) — skipped`);
      continue;
    }
    const dest = join(destDir, name);
    try {
      snapshotDatabase(source, dest);
    } catch (e) {
      io.err(`backup: ${source} -> ${dest} failed: ${String(e)}`);
      return 1;
    }
    io.out(`  ok    ${label}: ${source} -> ${dest}`);
    copied++;
  }
  io.out(`backup: ${copied} database(s) snapshotted into ${destDir} — now run: node src/main.ts verify ${destDir}`);
  return 0;
}

const VERIFY_USAGE = [
  'usage: node src/main.ts verify <path>...',
  '',
  'Verify database files (or every *.db in a directory): PRAGMA integrity_check',
  'plus the store invariants (UID monotonicity, live/expunged partition, the',
  'queue/dead-letter transactional-move invariant). Read-only: a backup is never',
  'modified by verifying it. Exit 1 if anything is unhealthy.',
].join('\n');

export function runVerify(args: string[], io: OpsIo): number {
  const paths: string[] = [];
  for (const a of args) {
    if (a === '--help' || a === '-h') {
      io.out(VERIFY_USAGE);
      return 0;
    }
    if (a.startsWith('--')) {
      io.err(`verify: unknown argument ${a}`);
      io.err(VERIFY_USAGE);
      return 2;
    }
    paths.push(a);
  }
  if (paths.length === 0) {
    io.err(VERIFY_USAGE);
    return 2;
  }
  // A directory expands to the *.db files inside it.
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      io.err(`verify: ${p} does not exist.`);
      return 2;
    }
    if (statSync(p).isDirectory()) {
      const inside = readdirSync(p).filter((f) => f.endsWith('.db')).map((f) => join(p, f));
      if (inside.length === 0) {
        io.err(`verify: no *.db files in ${p}.`);
        return 2;
      }
      files.push(...inside);
    } else files.push(p);
  }
  let failures = 0;
  for (const f of files) {
    const report = verifyDatabase(f);
    if (report.findings.length === 0) {
      io.out(`  ok    ${f} (${report.kind})`);
    } else {
      failures++;
      for (const finding of report.findings) io.out(` FAIL   ${f}: ${finding}`);
    }
  }
  io.out('');
  io.out(failures === 0 ? `verify: ${files.length} database(s) healthy` : `verify: ${failures} of ${files.length} database(s) UNHEALTHY`);
  return failures === 0 ? 0 : 1;
}
