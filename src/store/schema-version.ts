/**
 * Database schema versions, so a build can tell whether it is safe to open a file.
 *
 * Migrations here are forward-only and run on open: `AccountRegistry.open` creates an index,
 * `SqliteCatalog.open` adds columns. That is fine going forwards and silently wrong going
 * backwards — an older build meeting a database a newer one has migrated does not fail, it
 * misbehaves, because the statements it runs no longer match the shape of the data.
 *
 * That only became urgent with self-update (ADR 0025): a rollback after a failed cutover puts the
 * previous version in front of a database the candidate already migrated. Without a version stamp
 * the updater has to *guess* whether rollback is safe. With one it is a comparison.
 *
 * The contract each build declares:
 *   - `writes`  the version this build migrates a database TO
 *   - `reads`   the oldest version this build can still open (migrations bring it forward)
 *
 * Opening a database whose stamp is above `writes` is refused, loudly. Refusing to start beats
 * running against a shape we do not understand, for the same reason the case-collision check
 * refuses (ADR 0024): the failure is recoverable, the corruption would not be.
 */

import type { DatabaseSync } from 'node:sqlite';

/** Bump when a migration changes the control-database shape. */
export const CONTROL_SCHEMA = { writes: 1, reads: 0 } as const;
/** Bump when a migration changes a per-account mail-database shape. */
export const MAIL_SCHEMA = { writes: 1, reads: 0 } as const;

export interface SchemaContract {
  readonly writes: number;
  readonly reads: number;
}

/**
 * Read the stamp, refuse a database from the future, and stamp the current version otherwise.
 *
 * A stamp of 0 means "never stamped": every database written before this existed is, by
 * definition, at the shape the migrations produce, because those migrations run unconditionally on
 * every open. So 0 is adopted rather than treated as an error.
 *
 * Call AFTER the schema and its migrations have run, so the stamp always describes what is
 * actually on disk.
 */
export function stampSchema(db: DatabaseSync, kind: string, contract: SchemaContract): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const found = Number(row?.user_version ?? 0);
  if (found > contract.writes) {
    throw new Error(
      `${kind} database is at schema version ${found}, but this build understands at most ` +
        `${contract.writes}. It was migrated by a NEWER version of cutiemail; running an older ` +
        'build against it would not fail cleanly, it would write the wrong shape. Restore the ' +
        'snapshot taken before that upgrade, or run the newer version.',
    );
  }
  if (found < contract.reads) {
    throw new Error(
      `${kind} database is at schema version ${found}, which this build no longer migrates ` +
        `(it reads ${contract.reads} and above). Upgrade in steps through an intermediate version.`,
    );
  }
  if (found !== contract.writes) db.exec(`PRAGMA user_version = ${contract.writes}`);
}

/** The stamp on a database file, without opening it for use. 0 when never stamped. */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}
