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
 * Force a mail-database file to owner-only (0600) permissions. The DB holds SCRAM
 * credential material (salt/iterations/stored_key/server_key) and raw message bytes —
 * never group/world readable. The daemon's 0o077 umask makes NEW files 0600, but this
 * also fixes an ALREADY-DEPLOYED 0644 file. Best-effort and idempotent:
 * :memory:, a missing file, a read-only FS, or a foreign owner are all non-fatal.
 */
export function secureMailDbFile(path: string): void {
  if (path === ':memory:') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort: :memory:, ENOENT, a read-only FS, or a foreign owner is not fatal */
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
  } catch {
    /* :memory: and some builds don't support WAL — harmless */
  }
  // Tighten on the way in, so a handle opened on a pre-hardening 0644 file heals it.
  secureMailDbFile(path);
  return db;
}
