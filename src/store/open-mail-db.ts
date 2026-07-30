/**
 * The one place a mail database is opened. Every connection — the daemon's
 * control DB, each per-user mail DB (one file per user, opened on demand by more
 * than one of that user's IMAP connections plus the inbound delivery path), and
 * the test/conformance launchers — goes through here so they all share identical
 * durability and concurrency settings.
 *
 * WAL (https://sqlite.org/wal.html) is the "SQLite of email" durability posture:
 * a reader never blocks the writer and a writer never blocks readers, and a
 * crash is recovered by replaying the log. But WAL still permits only ONE writer
 * at a time. With multiple connections open on one file (every user connection
 * and every inbound delivery opens its own handle), a second writer that finds
 * the write lock already held gets SQLITE_BUSY *immediately* unless a busy
 * timeout is configured. PRAGMA busy_timeout makes a contending writer sleep and
 * retry for up to N ms before giving up, instead of failing on the first attempt
 * (https://sqlite.org/pragma.html#pragma_busy_timeout). Without it, two
 * connections appending or STOREing at the same time raise SQLITE_BUSY under
 * load — see src/store/sqlite-concurrency.integration.test.ts, whose negative
 * control removes this pragma and observes exactly that. 5000 ms is comfortably
 * longer than any single transaction here and is a common SQLite default.
 */

import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

/** The busy timeout every mail-database connection is opened with (ms). */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The lowest bundled SQLite version this project considers sound to run on.
 *
 * 3.51.3 (2026-03-13) carries the fix for the "WAL-reset database corruption bug"
 * (https://sqlite.org/changes.html). Every mail database here runs in WAL mode with more than one
 * connection open on the same file (each IMAP session and the inbound delivery path opens its own
 * handle), which is precisely the regime a WAL/checkpoint corruption bug threatens. SQLite is not a
 * dependency this project pins directly — it is whatever `node:sqlite` bundles — so the floor is not
 * enforced at open time (a hard refusal would strand a deployment on the only Node it can install).
 * It is asserted at runtime by `doctor`, which WARNS when the live `sqlite_version()` is below it,
 * the same advisory posture `backup verify` takes toward a stale WAL sidecar. Raise this only for a
 * fix that materially threatens data at rest, not for every point release.
 */
export const MIN_SQLITE_VERSION = '3.51.3';

/**
 * True iff dotted numeric version `actual` (e.g. a `sqlite_version()` string) is >= `floor`.
 * Pure and total so `doctor`'s version check can be driven in both directions by a test without a
 * real database. Missing trailing components read as 0 (`3.51` == `3.51.0`).
 */
export function sqliteVersionAtLeast(actual: string, floor: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(actual);
  const f = parts(floor);
  for (let i = 0; i < Math.max(a.length, f.length); i++) {
    const diff = (a[i] ?? 0) - (f[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true; // exactly equal
}

/**
 * The on-disk schema epoch this binary understands, stamped into PRAGMA user_version.
 * Migrations within a version are additive (a new table or a defaulted column, applied in
 * place by the owning catalog/registry), so an OLDER file is upgraded transparently. A file
 * carrying a HIGHER version was written by a newer cutiemail and is refused rather than opened
 * and written with semantically-degraded rows. Bump this whenever a schema change would make
 * an older binary's writes wrong (not merely for an additive column an older binary ignores).
 */
export const SCHEMA_VERSION = 1;

/**
 * Force a mail-database file to owner-and-group (0660), never world.
 *
 * The database holds SCRAM credential material (salt/iterations/stored_key/server_key) and raw
 * message bytes, so world access is denied absolutely and this also repairs an already-deployed
 * 0644 file. Best-effort and idempotent: `:memory:`, a missing file, a read-only filesystem or a
 * foreign owner are all non-fatal.
 *
 * WHY THE GROUP BITS ARE SET, having previously been 0600. These files live in a directory that is
 * already group-restricted, so access is decided by group membership before the file mode is ever
 * consulted; denying the group at the file level was a second boundary disagreeing with the first.
 * The disagreement had a cost. ADR 0025's updater runs as its own user and must read every database
 * to snapshot them — the whole of rung 6 — and must write the control database, because the cutover
 * probe mints and revokes a credential there. Granting that on top of a 0600 file cannot work: this
 * function runs on EVERY open, and a `chmod` resets a POSIX ACL's mask to nothing, so any grant
 * survived exactly until the daemon next restarted, which a cutover always does. The observed
 * result was a pre-flight that passed once and then failed forever, blaming the data.
 *
 * So the mode says "owner and group", and the GROUP is the deployment's access-control decision —
 * the conventional Unix way to say two service accounts share data, verifiable with `getent group`.
 * A deployment with no updater has one member in that group, where 0660 and 0600 are the same
 * thing. A deployment with one puts the updater in it, and that is the entire grant.
 *
 * WHY NOT 0640 FOR MAILBOXES, reserving write for the control database. It would need a "which kind
 * of database is this" flag threaded through `openMailDb`, whose entire job is to be the one safe
 * way to open a database — a uniform, hard-to-misuse function is exactly the wrong place to add a
 * mode parameter. And the boundary it would buy is not real: the updater chooses the code the
 * daemon runs next, so it can modify any mailbox by shipping a version that does. Denying the
 * direct write while leaving the indirect one is the kind of asymmetry that reads as security and
 * is not. What remains real is enforced here — world gets nothing — and what actually protects the
 * mail is that the DAEMON cannot write its own code (ADR 0025), which is untouched by this.
 */
export function secureMailDbFile(path: string): void {
  if (path === ':memory:') return;
  // All THREE files, because a WAL database is three files and SQLite opens all of them. Fixing
  // only the main one produced a database whose mode looked right and could not be opened: the
  // sidecars are recreated at every checkpoint under the process umask, so they reverted to
  // owner-only and refused every reader the main file had just admitted. The umask in main.ts is
  // the other half of this and must agree with it.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      chmodSync(path + suffix, 0o660);
    } catch {
      /* best-effort: :memory:, ENOENT (no sidecar yet), a read-only FS, or a foreign owner */
    }
  }
}

/** Open (or create) a mail database with the daemon's WAL + busy_timeout settings. */
export function openMailDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // busy_timeout is valid on every backing store (a harmless no-op on :memory:,
  // which has no cross-connection contention anyway), so it is set unconditionally.
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    // FULL, not NORMAL, and the difference is a durability contract this server makes over the wire.
    // Every acknowledgement path here commits its write BEFORE it acks — the SMTP receiver sends
    // `250` only after the delivery handler's COMMIT returns (smtp-receiver.ts), submission enqueues
    // and then acks, IMAP APPEND/COPY/MOVE commit and then reply OK. That ordering is worthless
    // under synchronous=NORMAL, where a COMMIT is durable against a *process* crash but NOT against
    // power loss until the next checkpoint: a message we already answered `250 OK` for can vanish on
    // a power cut, silently — the sender's MTA will never retry it. FULL fsyncs the WAL at each
    // commit, so `250` means "on stable storage", honouring the sequencing the code already has.
    // The cost is one fsync per acknowledged write; every bulk path is already ONE transaction
    // (sqlite-mailbox.ts `transaction()`), so at this project's scale the per-ack fsync is
    // negligible and correctness is the product. (Explicit rather than leaning on WAL's FULL default,
    // so a future default change or a stray PRAGMA cannot quietly weaken it.) See ADR 0028.
    db.exec('PRAGMA synchronous=FULL');
  } catch {
    /* :memory: and some builds don't support WAL/synchronous, harmless */
  }
  // Schema-version gate: refuse a database written by a NEWER cutiemail rather than opening it
  // and writing rows it will misread. Migrations within a version are additive, so a strictly
  // OLDER file is stamped forward and upgraded in place by its owning catalog/registry; only a
  // strictly-newer on-disk version is fatal.
  const onDisk = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (onDisk > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `database ${path} was written by a newer cutiemail (schema v${onDisk}); this binary understands up to v${SCHEMA_VERSION}. Upgrade the binary, or restore a backup taken by this version.`,
    );
  }
  if (onDisk < SCHEMA_VERSION) db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  // Tighten on the way in, so a handle opened on a pre-hardening 0644 file heals it.
  secureMailDbFile(path);
  return db;
}
