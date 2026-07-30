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
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotDatabase } from '../ops/backup.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry, validLogin } from '../store/account-registry.ts';

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
 *
 * THE LOGIN IS UNTRUSTED HERE. It arrives from the control database, which belongs to the mail
 * daemon — the internet-facing process ADR 0025 exists to contain — so it is attacker-influenced in
 * exactly the case the whole two-user design is built for. Interpolating it into a path unchecked
 * let a daemon-chosen `..` sequence steer `VACUUM INTO` into the version store: a write the daemon
 * cannot perform itself, performed on its behalf by the one process that can. A sandbox cannot stop
 * that, because it constrains which process writes and the wrong process is doing the writing.
 *
 * Both guards are here rather than at the call sites, because there are two call sites and a rule
 * that has to be remembered twice is a rule that will be applied once. `validLogin` is the same
 * predicate the account CLI enforces on creation; the containment assertion is the backstop for the
 * day that predicate is loosened.
 */
function snapshotPathFor(destDir: string, login: string): string {
  if (!validLogin(login)) {
    throw new SnapshotError(
      `account login ${JSON.stringify(login)} is not a valid login, so it cannot be part of a filename. ` +
        'The control database has been written by something other than the account CLI; refusing to snapshot.',
    );
  }
  const path = join(destDir, `mail-${login}.db`);
  if (!resolve(path).startsWith(resolve(destDir) + sep)) {
    throw new SnapshotError(`the snapshot path for ${JSON.stringify(login)} escapes ${destDir}; refusing to snapshot`);
  }
  return path;
}

/**
 * The SOURCE half of the same rule, and it was missing.
 *
 * `snapshotPathFor` above validates the login and asserts containment for the path we WRITE. Its
 * sibling — `mail_db_path`, read from the same daemon-owned control database, and named as
 * attacker-influenced in this file's own header — was passed to `openMailDb` untouched. That
 * matters because `new DatabaseSync(path)` opens with `O_RDWR|O_CREAT` and no `O_NOFOLLOW`: a
 * symlink planted by a compromised daemon is FOLLOWED, and if the target does not exist it is
 * CREATED. Pointed at `/opt/mailserver/versions/<sha>`, that put a file inside the code store the
 * daemon is architecturally forbidden to write (ADR 0025's headline invariant), and `promote()`
 * then discarded the content-verified checkout in favour of it.
 *
 * Two checks, because they refuse different things:
 *  - `lstatSync` without following: the source must already exist AS A REGULAR FILE. A symlink or
 *    a dangling path is refused, which removes the create-a-new-file primitive entirely.
 *  - containment: the resolved path must be inside the data directory. A mail database elsewhere
 *    is not something auto-update supports, and saying so is better than copying from wherever a
 *    compromised process points us.
 *
 * A perfectly-timed swap between this check and SQLite's own open remains possible in principle —
 * `node:sqlite` opens by path and offers no descriptor-based entry point, so the window cannot be
 * closed from here. It is recorded in docs/BACKLOG.md rather than papered over. What it is not any
 * more is a steady-state primitive: the path has to be a real file at rest.
 */
function assertSnapshotSource(mailDbPath: string, dataDir: string): void {
  const st = lstatSync(mailDbPath, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) {
    throw new SnapshotError(
      `refusing to snapshot ${JSON.stringify(mailDbPath)}: it is not a regular file. ` +
        'The control database has been written by something other than the account CLI.',
    );
  }
  if (!resolve(mailDbPath).startsWith(resolve(dataDir) + sep)) {
    throw new SnapshotError(
      `refusing to snapshot ${JSON.stringify(mailDbPath)}: it is outside the data directory ${dataDir}`,
    );
  }
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

  // An account whose database has not been created yet is legitimate and is skipped. Anything
  // that EXISTS as something other than a regular file is not: `existsSync` follows symlinks, so
  // it answered "absent" for a dangling link and "present" for one aimed anywhere at all, which
  // is precisely the distinction that matters here. `lstatSync` asks about the path itself.
  const sources = [
    { login: '', path: controlDbPath },
    ...accounts
      .filter((a) => a.mailDbPath !== ':memory:' && lstatSync(a.mailDbPath, { throwIfNoEntry: false }) !== undefined)
      .map((a) => ({ login: a.login, path: a.mailDbPath })),
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

  // EVERY destination is computed before ANY of them is written. The containment rule in
  // `snapshotPathFor` is only worth having if it runs before the write it is guarding: checking as
  // we go would refuse the escaping path having already copied the accounts that sorted ahead of
  // it, which is the difference between a refusal and a partial breach.
  // Both halves of every path are checked here, before anything is written — the login-derived
  // destination AND the daemon-supplied source. Checking as we go would refuse the escaping entry
  // having already copied the accounts that sorted ahead of it.
  const dataDir = dirname(controlDbPath);
  for (const s of sources.slice(1)) assertSnapshotSource(s.path, dataDir);
  const destinations = sources.slice(1).map((s) => ({ login: s.login, from: s.path, to: snapshotPathFor(destDir, s.login) }));

  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  chmodSync(destDir, 0o700); // explicit: this directory holds every secret the live system holds
  const controlCopy = join(destDir, 'control.db');
  const mailDbs: Array<{ login: string; path: string }> = [];
  try {
    snapshotDatabase(controlDbPath, controlCopy);
    for (const d of destinations) {
      snapshotDatabase(d.from, d.to);
      mailDbs.push({ login: d.login, path: d.to });
    }
    redirectAccountsIntoSnapshot(controlCopy, destDir);
  } catch (e) {
    // A snapshot that failed half-way is not a snapshot, and what it did write is a copy of live
    // mail sitting on disk. The caller cannot clean it up, because it never received the handle
    // whose `destroy` would have done it.
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }

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

/**
 * The two high-water marks that govern identifiers NOT YET ALLOCATED.
 *
 * Censused because their loss is invisible in everything else: every mailbox and every message is
 * still present and byte-identical, and the damage arrives later, when the next CREATE hands out a
 * UIDVALIDITY that collides with a live mailbox's — which sqlite-mailbox.ts's own comment says must
 * never happen, because a client caches by (UIDVALIDITY, UID). A decrease is loss even though
 * nothing is missing yet.
 */
export interface CatalogMarks {
  readonly login: string;
  readonly uidValidityHwm: number;
  readonly mailboxIdHwm: number;
}

export interface Census {
  readonly accounts: ReadonlyArray<{ readonly login: string; readonly enabled: boolean; readonly aliases: readonly string[] }>;
  readonly mailboxes: readonly MailboxCensus[];
  readonly catalogMarks: readonly CatalogMarks[];
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
  /**
   * A hash over every account's stored authentication material — the SCRAM salt, iteration count,
   * stored key and server key, and the same for each app password.
   *
   * The failure this exists to catch is total and invisible: a migration that rewrites, re-encodes
   * or drops credential rows logs every client out permanently, while the server reports itself
   * perfectly healthy and every other check passes. Message counts are intact, the schema moved
   * forward as expected, the mail path works — because the mail path is exercised with a credential
   * the pre-flight minted for itself, which proves the auth ALGORITHM works and says nothing about
   * whether your existing verifiers survived.
   *
   * The secret is not here and cannot be derived from what is: SCRAM stores a salted, iterated
   * verifier precisely so that possessing it is not possessing the password. That is also why this
   * has to be a continuity check rather than a login attempt — the updater has no password to
   * authenticate with, and should not be able to obtain one.
   */
  readonly credentialDigest: string;
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number | bigint }).c);

/**
 * The columns `table` has right now, or an empty set if the table does not exist. `pragma_table_info`
 * neither throws nor returns rows for an absent table, so this doubles as an existence check.
 *
 * This is the SINGLE way censusOf asks a mail database what it holds before reading it. Mail
 * databases migrate when their catalog is opened, and a catalog is opened when its account is used,
 * so a registered-but-dormant account sits at an older, additive schema indefinitely while
 * `PRAGMA user_version` reads exactly the same as an up-to-date one (these migrations are reconciled
 * by column probe, not a version bump). A read that NAMES a not-yet-migrated column or table throws
 * `no such column`/`no such table` at prepare time and fails every future update on an otherwise
 * healthy deployment — misreported against the candidate as "migration against your data". Routing
 * every migration-sensitive read through this one probe is what stops any individual SELECT becoming
 * the unmirrored sibling that reintroduces that crash: absent reads as its post-migration default,
 * and compareCensus only ever flags a mark that moved BACKWARDS, so adding a column is forward.
 */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  // pragma_table_info takes a LITERAL, not a bound parameter: parameterising it makes SQLite build
  // a temporary structure and throw "attempt to write a readonly database" on the read-only
  // snapshot handle this always runs against. `table` is a compile-time constant at every call
  // site, so interpolation is safe; the identifier check keeps it safe if that ever stops holding.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
}

/** Read a census from a snapshot, strictly read-only so taking one can never alter what it measures. */
export function censusOf(snapshot: Snapshot): Census {
  const control = new DatabaseSync(snapshot.controlDb, { readOnly: true });
  let accounts: Array<{ login: string; enabled: boolean; aliases: string[] }>;
  let queueDepth: number;
  let deadLetters: number;
  let queueDigest: string;
  let credentialDigest: string;
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
    // Every account's authentication material, and every app password's, hashed in a stable order.
    // The columns are named explicitly rather than taken with SELECT *: a migration that ADDS a
    // column would otherwise change this digest and be reported as credential loss, which is the
    // one thing a check like this must never cry wolf about.
    const c = createHash('sha256');
    const cred = control
      .prepare('SELECT login, salt, iterations, hash, stored_key, server_key FROM accounts ORDER BY login')
      .all() as Array<{ login: string; salt: Uint8Array; iterations: number; hash: string; stored_key: Uint8Array; server_key: Uint8Array }>;
    for (const r of cred) {
      c.update(`${r.login}\0${r.iterations}\0${r.hash}\0`);
      c.update(r.salt);
      c.update(r.stored_key);
      c.update(r.server_key);
    }
    const app = control
      .prepare('SELECT login, name, salt, iterations, hash, stored_key, server_key FROM app_passwords ORDER BY login, name')
      .all() as Array<{ login: string; name: string; salt: Uint8Array; iterations: number; hash: string; stored_key: Uint8Array; server_key: Uint8Array }>;
    for (const r of app) {
      c.update(`${r.login}\0${r.name}\0${r.iterations}\0${r.hash}\0`);
      c.update(r.salt);
      c.update(r.stored_key);
      c.update(r.server_key);
    }
    credentialDigest = c.digest('hex');
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
  const catalogMarks: CatalogMarks[] = [];
  const mailSchemaVersions: Record<string, number> = {};
  const digest = createHash('sha256');
  for (const { login, path } of snapshot.mailDbs) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      mailSchemaVersions[login] = Number((db.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version);
      // Ask what this database HAS before asking for it — via the single columnsOf probe, so no
      // read here can name a column an additive, open-triggered migration has not added yet and
      // crash the census on a dormant old-schema account (see columnsOf). Absent is not
      // zero-by-accident, it is zero by definition: a mark that does not exist cannot have been
      // lowered, and compareCensus only reports a mark that moved BACKWARDS; the candidate's
      // migration adds the column seeded past every id in use, which is forward.
      const catalogCols = columnsOf(db, 'catalog_meta');
      const markColumns = ['uid_validity_hwm', 'mailbox_id_hwm'].filter((c) => catalogCols.has(c));
      const marks = markColumns.length === 0
        ? undefined
        : (db.prepare(`SELECT ${markColumns.join(', ')} FROM catalog_meta WHERE id = 0`).get() as
            | Partial<Record<'uid_validity_hwm' | 'mailbox_id_hwm', number | bigint>>
            | undefined);
      catalogMarks.push({
        login,
        uidValidityHwm: Number(marks?.uid_validity_hwm ?? 0),
        mailboxIdHwm: Number(marks?.mailbox_id_hwm ?? 0),
      });
      // `name` is additive (migrateNameColumn): a database predating multi-mailbox has a single
      // INBOX and no name column, so read it tolerantly. The default is migrateNameColumn's OWN
      // 'INBOX', so the digest key a dormant database produces matches what the candidate's
      // migration will fill in — the absence reads as forward movement, never as a change. The
      // whole-word alias keeps the projection and ORDER BY byte-identical for an up-to-date schema.
      const mailboxCols = columnsOf(db, 'mailbox');
      const nameExpr = mailboxCols.has('name') ? '"name"' : `'INBOX'`;
      const boxes = (mailboxCols.size === 0
        ? []
        : db.prepare(`SELECT id, ${nameExpr} AS name, uid_next, uid_validity FROM mailbox ORDER BY name`).all()) as Array<{
        id: number;
        name: string;
        uid_next: number;
        uid_validity: number;
      }>;
      // Whether the flag / expunge-journal tables exist at all (probed once per database, not per
      // mailbox). Base tables today, but read through the same tolerance so a database predating
      // either is censused as empty rather than crashing the update — no unmirrored sibling.
      const hasFlagTable = columnsOf(db, 'flag').size > 0;
      const hasExpungedTable = columnsOf(db, 'expunged').size > 0;
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
        // internal_date is in the digest because it is what IMAP SINCE/BEFORE and every client's
        // sort order run on: a migration that zeroed it would leave every message present, every
        // byte identical, and every mailbox unusable in date order.
        const rows = db.prepare('SELECT uid, raw, internal_date FROM message WHERE mailbox_id = ? ORDER BY uid').all(box.id) as Array<{
          uid: number;
          raw: Buffer;
          internal_date: number | bigint;
        }>;
        // Flags are per (mailbox, uid) rather than on the message row, so they are read once per
        // mailbox and indexed, not queried per message. Losing them marks every message in every
        // account unread and discards every pending \\Deleted — user-visible, and irreversible once
        // the pre-cutover snapshot is pruned.
        const flagRows = (hasFlagTable
          ? db.prepare('SELECT uid, flag FROM flag WHERE mailbox_id = ? ORDER BY uid, flag').all(box.id)
          : []) as Array<{
          uid: number;
          flag: string;
        }>;
        const flagsByUid = new Map<number, string[]>();
        for (const f of flagRows) {
          const list = flagsByUid.get(Number(f.uid));
          if (list === undefined) flagsByUid.set(Number(f.uid), [f.flag]);
          else list.push(f.flag);
        }
        // The expunge journal is what QRESYNC replays to a reconnecting client. Dropping it does
        // not lose mail, but it silently degrades every phone's fast resync into a full refetch.
        const expunged = (hasExpungedTable
          ? db.prepare('SELECT uid, mod_seq FROM expunged WHERE mailbox_id = ? ORDER BY uid').all(box.id)
          : []) as Array<{
          uid: number;
          mod_seq: number | bigint;
        }>;
        for (const e of expunged) digest.update(`${login}\0${box.name}\0X\0${e.uid}\0${String(e.mod_seq)}\0`);
        for (const row of rows) {
          digest.update(`${login}\0${box.name}\0${row.uid}\0${row.raw.length}\0${String(row.internal_date)}\0`);
          digest.update(`${(flagsByUid.get(Number(row.uid)) ?? []).join(',')}\0`);
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
    catalogMarks,
    queueDepth,
    deadLetters,
    queueDigest,
    messageDigest: digest.digest('hex'),
    messageBytes,
    digestIsFull,
    controlSchemaVersion,
    mailSchemaVersions,
    credentialDigest,
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

  // The marks that govern identifiers not yet allocated. A DECREASE is the finding: raising a
  // high-water mark is how a migration legitimately reserves room, but lowering one hands the next
  // CREATE a UIDVALIDITY or mailbox id that a live — or recently deleted — mailbox already holds,
  // and a client that caches by (UIDVALIDITY, UID) then reads one folder's mail as another's.
  const marksOf = (c: Census): Map<string, CatalogMarks> => new Map(c.catalogMarks.map((m) => [m.login, m]));
  const beforeMarks = marksOf(before);
  for (const [login, a] of marksOf(after)) {
    const b = beforeMarks.get(login);
    if (b === undefined) continue;
    if (a.uidValidityHwm < b.uidValidityHwm) {
      findings.push(
        `${login}: the UIDVALIDITY high-water mark went BACKWARDS, ${b.uidValidityHwm} -> ${a.uidValidityHwm}. ` +
          'The next mailbox created would reuse a value a live or deleted one already holds.',
      );
    }
    if (a.mailboxIdHwm < b.mailboxIdHwm) {
      findings.push(`${login}: the mailbox-id high-water mark went BACKWARDS, ${b.mailboxIdHwm} -> ${a.mailboxIdHwm}`);
    }
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

  // Authentication material must survive a migration byte for byte. Losing it is the quietest
  // catastrophe available: nothing is deleted, no message moves, the server comes up and reports
  // itself healthy, and every client is locked out permanently. It is also unrecoverable without
  // the snapshot — the passwords cannot be re-derived from what is stored, by design.
  //
  // Note what this catches that the mail-path rung cannot: that rung authenticates with a
  // credential the pre-flight minted for itself moments earlier, so it proves the auth algorithm
  // works on a NEW verifier while saying nothing about the ones your clients already hold.
  if (after.credentialDigest !== before.credentialDigest) {
    findings.push(
      'stored authentication material changed across the migration. Every existing client credential ' +
        'would stop working, and the passwords cannot be recovered from what is stored.',
    );
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
