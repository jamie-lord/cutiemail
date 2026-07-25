/**
 * A private copy of the live data, and a census of what is in it.
 *
 * This is what makes rung 6 of ADR 0025 possible: the candidate is booted against a snapshot of
 * YOUR databases with YOUR configuration, so the questions that actually break deployments —
 * does the migration succeed at your size, how long does it take, does your configuration still
 * satisfy the new version — get answered before the switch rather than after it.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, and both are the difference between a safe check and a
 * catastrophe:
 *
 * 1. **The mail-database paths inside the snapshot are rewritten.** The control database stores an
 *    absolute path per account. A verbatim copy therefore still points at the LIVE mailbox files,
 *    and a candidate booted against it would open, migrate and write the real mail while calling
 *    itself a test. The rewrite is what makes the copy actually a copy.
 *
 * 2. **The census is taken before and after, and compared.** Not as reassurance, but as the
 *    enforcement mechanism for the other absolute rule of rung 6: the snapshot contains the
 *    outbound queue, and a candidate booted in `deliver` mode would relay every queued message a
 *    second time. `MAIL_OUTBOUND=hold` is forced — and the queue depth surviving the boot unchanged
 *    is the evidence that it worked. A regression that dropped the override would be visible as
 *    messages vanishing from the queue.
 *
 * The snapshot holds every secret the live system holds — SCRAM material, app passwords, raw mail —
 * so the directory is 0700 and each file 0600, and it is destroyed whatever the outcome.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotDatabase } from '../ops/backup.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';

export class SnapshotError extends Error {}

/**
 * Headroom required over the size of the data before a snapshot is attempted.
 *
 * A snapshot that fills the disk is worse than no snapshot: the LIVE databases share that disk, and
 * SQLite handling ENOSPC on the write path is a fault-injection scenario the suite covers precisely
 * because it is nasty. Refusing early is free.
 */
const DISK_HEADROOM = 2.5;

export interface Snapshot {
  readonly dir: string;
  readonly controlDb: string;
  readonly mailDbs: ReadonlyArray<{ readonly login: string; readonly path: string }>;
  readonly bytes: number;
  destroy(): void;
}

/** SQL string-literal escape, mirroring backup.ts. */
const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Total size of a database file and any sidecars beside it. */
function dbBytes(path: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      // Absent sidecars are normal.
    }
  }
  return total;
}

/**
 * Where an account's mail database lives inside a snapshot.
 *
 * One rule, used both to write the copies and to rewrite the paths that point at them. When those
 * were two separate computations that happened to agree, neither was individually load-bearing:
 * deleting either one left the other quietly doing its job, and no test could tell.
 */
function snapshotPathFor(destDir: string, login: string): string {
  return join(destDir, `mail-${login}.db`);
}

/**
 * Point every account in a snapshotted control database at its copy, and refuse if any still is not.
 *
 * THE step that makes a copy actually a copy. Until it runs, the snapshot names the LIVE mailbox
 * files, and a candidate booted against it would open, migrate and write real mail while believing
 * it was running against a copy.
 *
 * The trailing assertion is not decoration. It is the difference between "the rewrite is correct"
 * and "the rewrite was proven to have covered everything before anything was allowed to run", and
 * there is no safe partial version of it — an account left pointing outside means real mail is
 * reachable. Exported so that assertion can be exercised directly, on a database where the rewrite
 * deliberately did not happen.
 */
export function redirectAccountsIntoSnapshot(controlCopyPath: string, destDir: string, rewrite = true): void {
  const db = new DatabaseSync(controlCopyPath);
  try {
    if (rewrite) {
      const update = db.prepare('UPDATE accounts SET mail_db_path = ? WHERE login = ?');
      // Every account, not only the ones whose database existed: one that has never received mail
      // has no file to copy, but a candidate may well decide to create it, and it must create it
      // here.
      const logins = db.prepare("SELECT login FROM accounts WHERE mail_db_path <> ':memory:'").all() as Array<{ login: string }>;
      for (const { login } of logins) update.run(snapshotPathFor(destDir, login), login);
    }
    const outside = db
      .prepare("SELECT login, mail_db_path FROM accounts WHERE mail_db_path NOT LIKE ? AND mail_db_path <> ':memory:'")
      .all(`${destDir}/%`) as Array<{ login: string; mail_db_path: string }>;
    if (outside.length > 0) {
      throw new SnapshotError(
        `${outside.length} account(s) in the snapshot still point at live mail databases ` +
          `(${outside.map((r) => `${r.login} -> ${r.mail_db_path}`).join(', ')}); refusing to use it`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Snapshot the control database and every account's mail database into `destDir`.
 *
 * `VACUUM INTO` gives a transactionally consistent copy while the daemon is writing, which a `cp`
 * of a live WAL database emphatically does not — the same reason `backup` uses it.
 */
export function takeSnapshot(controlDbPath: string, destDir: string): Snapshot {
  if (!existsSync(controlDbPath)) throw new SnapshotError(`control database ${controlDbPath} does not exist`);
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });

  const controlDb = openMailDb(controlDbPath);
  let accounts: ReadonlyArray<{ login: string; mailDbPath: string }>;
  try {
    accounts = AccountRegistry.open(controlDb).list().map((a) => ({ login: a.login, mailDbPath: a.mailDbPath }));
  } finally {
    controlDb.close();
  }

  const sources = [
    { login: '', path: controlDbPath },
    ...accounts.filter((a) => a.mailDbPath !== ':memory:' && existsSync(a.mailDbPath)).map((a) => ({ login: a.login, path: a.mailDbPath })),
  ];
  const needed = sources.reduce((sum, s) => sum + dbBytes(s.path), 0);

  // Free space is checked against the SNAPSHOT's filesystem, which may differ from the data's — so
  // the parent has to exist before it can be measured.
  mkdirSync(dirname(destDir), { recursive: true, mode: 0o700 });
  const fs = statfsSync(dirname(destDir));
  const free = Number(fs.bavail) * Number(fs.bsize);
  if (free < needed * DISK_HEADROOM) {
    throw new SnapshotError(
      `not enough free space for a snapshot: ${needed} bytes of databases need about ${Math.round(needed * DISK_HEADROOM)} bytes free, ` +
        `and ${dirname(destDir)} has ${free}. Refusing, because filling this disk would take the live databases down with it.`,
    );
  }

  // No collision check on the snapshot filenames, deliberately. `backup` needs one because it names
  // copies after the SOURCE file, which two accounts can share; here the name comes from the login,
  // and two logins differing only in case are one identity (ADR 0024), enforced by a unique index
  // on lower(login) that `AccountRegistry.open` above would have refused to create. A guard here
  // could never fire, and untestable code that looks like a safeguard is worse than the comment
  // that explains why it is not needed.

  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  chmodSync(destDir, 0o700); // explicit: this directory holds every secret the live system holds
  const controlCopy = join(destDir, 'control.db');
  snapshotDatabase(controlDbPath, controlCopy);
  const mailDbs: Array<{ login: string; path: string }> = [];
  for (const source of sources.slice(1)) {
    const copy = snapshotPathFor(destDir, source.login);
    snapshotDatabase(source.path, copy);
    mailDbs.push({ login: source.login, path: copy });
  }

  redirectAccountsIntoSnapshot(controlCopy, destDir);

  let bytes = 0;
  for (const path of [controlCopy, ...mailDbs.map((m) => m.path)]) bytes += dbBytes(path);

  return {
    dir: destDir,
    controlDb: controlCopy,
    mailDbs,
    bytes,
    destroy: () => rmSync(destDir, { recursive: true, force: true }),
  };
}

/**
 * Beyond this many bytes of stored mail, message bodies are fingerprinted by length plus their
 * first and last 8 KiB rather than in full.
 *
 * Hashing everything is the stronger check and is what runs on any ordinary instance. But a
 * pre-flight that takes twenty minutes gets killed by a service timeout, and an update that never
 * completes is the rot this whole mechanism exists to prevent. The report says which form was used
 * rather than leaving the reader to assume the stronger one.
 */
export const FULL_DIGEST_LIMIT_BYTES = 512 * 1024 * 1024;

export interface MailboxCensus {
  readonly login: string;
  readonly mailbox: string;
  readonly messages: number;
  readonly uidNext: number;
  readonly uidValidity: number;
}

export interface Census {
  readonly accounts: ReadonlyArray<{ readonly login: string; readonly enabled: boolean; readonly aliases: readonly string[] }>;
  readonly mailboxes: readonly MailboxCensus[];
  readonly queueDepth: number;
  readonly deadLetters: number;
  /**
   * A hash over each queued message's id, remaining recipients, attempt count and next attempt
   * time.
   *
   * This is what turns "hold mode was forced" from an assertion into evidence. A relay tick that
   * ran and failed does not remove the row — it reschedules it, incrementing `attempts` and moving
   * `next_attempt` — so a depth comparison alone would miss it entirely. Any relay activity at all
   * changes this digest.
   */
  readonly queueDigest: string;
  /** A hash over every stored message: which mailbox, which uid, and the bytes. */
  readonly messageDigest: string;
  readonly messageBytes: number;
  /** False when bodies were fingerprinted rather than hashed whole (see FULL_DIGEST_LIMIT_BYTES). */
  readonly digestIsFull: boolean;
  readonly controlSchemaVersion: number;
  readonly mailSchemaVersions: Readonly<Record<string, number>>;
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number | bigint }).c);

/** Read a census from a snapshot, strictly read-only so taking one can never alter what it measures. */
export function censusOf(snapshot: Snapshot): Census {
  const control = new DatabaseSync(snapshot.controlDb, { readOnly: true });
  let accounts: Array<{ login: string; enabled: boolean; aliases: string[] }>;
  let queueDepth: number;
  let deadLetters: number;
  let queueDigest: string;
  let controlSchemaVersion: number;
  try {
    const rows = control.prepare('SELECT login, enabled FROM accounts ORDER BY login').all() as Array<{ login: string; enabled: number }>;
    const aliasRows = control.prepare('SELECT alias, login FROM aliases ORDER BY alias').all() as Array<{ alias: string; login: string }>;
    accounts = rows.map((r) => ({
      login: r.login,
      enabled: r.enabled === 1,
      aliases: aliasRows.filter((a) => a.login === r.login).map((a) => a.alias),
    }));
    queueDepth = count(control, 'SELECT COUNT(*) c FROM outbound_queue');
    deadLetters = count(control, 'SELECT COUNT(*) c FROM dead_letter');
    const queueRows = control
      .prepare('SELECT id, recipients, attempts, next_attempt FROM outbound_queue ORDER BY id')
      .all() as Array<{ id: string; recipients: string; attempts: number; next_attempt: number }>;
    const q = createHash('sha256');
    for (const r of queueRows) q.update(`${r.id}\0${r.recipients}\0${r.attempts}\0${r.next_attempt}\0`);
    queueDigest = q.digest('hex');
    controlSchemaVersion = Number((control.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version);
  } finally {
    control.close();
  }

  // Two passes: size everything first, so the digest form is chosen from the whole corpus rather
  // than switching part way through and producing a hash that means neither thing.
  let messageBytes = 0;
  for (const { path } of snapshot.mailDbs) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      messageBytes += Number((db.prepare('SELECT COALESCE(SUM(LENGTH(raw)), 0) c FROM message').get() as { c: number | bigint }).c);
    } finally {
      db.close();
    }
  }
  const digestIsFull = messageBytes <= FULL_DIGEST_LIMIT_BYTES;

  const mailboxes: MailboxCensus[] = [];
  const mailSchemaVersions: Record<string, number> = {};
  const digest = createHash('sha256');
  for (const { login, path } of snapshot.mailDbs) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      mailSchemaVersions[login] = Number((db.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version);
      const boxes = db.prepare('SELECT id, name, uid_next, uid_validity FROM mailbox ORDER BY name').all() as Array<{
        id: number;
        name: string;
        uid_next: number;
        uid_validity: number;
      }>;
      for (const box of boxes) {
        const messages = Number(
          (db.prepare('SELECT COUNT(*) c FROM message WHERE mailbox_id = ?').get(box.id) as { c: number | bigint }).c,
        );
        mailboxes.push({
          login,
          mailbox: box.name,
          messages,
          uidNext: Number(box.uid_next),
          uidValidity: Number(box.uid_validity),
        });
        // Ordered by uid so the digest is a function of the content, not of SQLite's row order.
        const rows = db.prepare('SELECT uid, raw FROM message WHERE mailbox_id = ? ORDER BY uid').all(box.id) as Array<{ uid: number; raw: Buffer }>;
        for (const row of rows) {
          digest.update(`${login}\0${box.name}\0${row.uid}\0${row.raw.length}\0`);
          if (digestIsFull) digest.update(row.raw);
          else {
            digest.update(row.raw.subarray(0, 8192));
            digest.update(row.raw.subarray(Math.max(0, row.raw.length - 8192)));
          }
        }
      }
    } finally {
      db.close();
    }
  }

  return {
    accounts,
    mailboxes,
    queueDepth,
    deadLetters,
    queueDigest,
    messageDigest: digest.digest('hex'),
    messageBytes,
    digestIsFull,
    controlSchemaVersion,
    mailSchemaVersions,
  };
}

/**
 * What changed between two censuses.
 *
 * A schema version moving FORWARD is expected — that is what a migration does, and it is recorded
 * rather than flagged, because the cutover needs to know (an older binary cannot safely read a
 * newer database, so a rollback after a forward migration has to restore the snapshot). Everything
 * else changing means the migration lost or altered data, and there is no such thing as an
 * acceptable amount of that.
 */
export function compareCensus(before: Census, after: Census): string[] {
  const findings: string[] = [];

  const loginsOf = (c: Census): string => c.accounts.map((a) => `${a.login}:${a.enabled ? 'on' : 'off'}[${a.aliases.join('|')}]`).join(',');
  if (loginsOf(before) !== loginsOf(after)) {
    findings.push(`accounts changed across the migration: before [${loginsOf(before)}], after [${loginsOf(after)}]`);
  }

  const key = (m: MailboxCensus): string => `${m.login}/${m.mailbox}`;
  const beforeBoxes = new Map(before.mailboxes.map((m) => [key(m), m]));
  const afterBoxes = new Map(after.mailboxes.map((m) => [key(m), m]));
  for (const [k, b] of beforeBoxes) {
    const a = afterBoxes.get(k);
    if (a === undefined) {
      findings.push(`mailbox ${k} disappeared across the migration`);
      continue;
    }
    if (a.messages !== b.messages) findings.push(`mailbox ${k}: ${b.messages} message(s) before, ${a.messages} after`);
    // UIDVALIDITY changing forces every IMAP client to discard its cache and re-download the whole
    // mailbox (RFC 9051 §2.3.1.1). Not data loss, but not something to discover from users.
    if (a.uidValidity !== b.uidValidity) findings.push(`mailbox ${k}: UIDVALIDITY changed ${b.uidValidity} -> ${a.uidValidity}, which would force every client to resynchronise`);
    if (a.uidNext < b.uidNext) findings.push(`mailbox ${k}: uid_next went backwards ${b.uidNext} -> ${a.uidNext}, which would reuse UIDs`);
  }
  // A mailbox present only afterwards is normal and deliberately not flagged: the daemon
  // provisions the RFC 6154 special-use folders (Sent, Drafts, Trash, Junk, Archive) when it first
  // opens a store, so a snapshot of an account that predates them gains them on boot.

  if (before.messageDigest !== after.messageDigest) {
    findings.push(`stored message bytes changed across the migration (${before.digestIsFull ? 'full' : 'sampled'} digest over ${before.messageBytes} bytes)`);
  }

  // The evidence that MAIL_OUTBOUND=hold took effect. A successful relay removes the row; a FAILED
  // one reschedules it, bumping attempts and next_attempt — so the digest is the check that
  // actually bites, and the depth is only the loudest symptom.
  if (after.queueDepth !== before.queueDepth || after.queueDigest !== before.queueDigest) {
    findings.push(
      `the outbound queue changed while the candidate ran (${before.queueDepth} message(s) before, ${after.queueDepth} after` +
        `${after.queueDigest !== before.queueDigest ? '; delivery state differs' : ''}). ` +
        'Hold mode should have made that impossible: the candidate may have relayed queued mail a second time.',
    );
  }
  if (after.deadLetters !== before.deadLetters) {
    findings.push(`dead letters changed from ${before.deadLetters} to ${after.deadLetters} while the candidate ran`);
  }

  if (after.controlSchemaVersion < before.controlSchemaVersion) {
    findings.push(`the candidate moved the control schema BACKWARDS, ${before.controlSchemaVersion} -> ${after.controlSchemaVersion}`);
  }
  for (const [login, version] of Object.entries(before.mailSchemaVersions)) {
    const now = after.mailSchemaVersions[login];
    if (now !== undefined && now < version) findings.push(`the candidate moved ${login}'s mail schema BACKWARDS, ${version} -> ${now}`);
  }

  return findings;
}

/** Did the candidate migrate either database kind forward? Decides whether rollback needs a restore. */
export function schemaMovedForward(before: Census, after: Census): boolean {
  if (after.controlSchemaVersion > before.controlSchemaVersion) return true;
  for (const [login, version] of Object.entries(after.mailSchemaVersions)) {
    const was = before.mailSchemaVersions[login];
    if (was !== undefined && version > was) return true;
  }
  return false;
}
