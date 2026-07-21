/**
 * The SQLite-backed outbound queue — persistence for the send leg.
 *
 * The reference DeliveryQueue (queue.ts) specifies the retry state machine; this
 * gives it a home that survives a restart. A message the relay can't deliver now
 * (greylisted with a 4yz, recipient MX down, DNS hiccup) is stored here with its
 * envelope and signed bytes, and the relay loop retries it on the shared
 * `decideRetry` schedule until it delivers or gives up. Before this, a transient
 * failure dropped the message with only a log line — real mail lost to the
 * ubiquitous greylist.
 *
 * Recovery is free: the queue is a table in the same database, so on startup the
 * loop's first tick finds whatever was left in flight. Bytes, never strings: the
 * message is a BLOB, relayed byte-exact.
 *
 * When the relay finally gives up on a message (a permanent 5yz, or the give-up
 * window elapsing), the sender is bounced — but the bytes are ALSO retained here in
 * a `dead_letter` table rather than silently dropped from our side, so an operator
 * can inspect, re-queue, or purge them. The move off the live queue is transactional
 * (see `deadLetter`), so a crash can never leave a message removed-but-not-retained.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound_queue (
  id TEXT PRIMARY KEY,
  from_addr TEXT NOT NULL,
  recipients TEXT NOT NULL,   -- JSON array of the not-yet-delivered recipients
  data BLOB NOT NULL,
  first_queued INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dead_letter (
  id TEXT PRIMARY KEY,        -- the original queue entry's id, carried across
  from_addr TEXT NOT NULL,
  recipients TEXT NOT NULL,   -- JSON array of the recipients we gave up on
  data BLOB NOT NULL,
  first_queued INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,   -- the failure that ended delivery (classification + detail)
  dead_lettered INTEGER NOT NULL
);
`;

export interface QueueEntry {
  readonly id: string;
  readonly from: string;
  readonly recipients: readonly string[];
  readonly data: Buffer;
  readonly firstQueued: number;
  readonly attempts: number;
  readonly nextAttempt: number;
}

/** The raw dead_letter row shape as read back from SQLite. */
interface DeadLetterRow {
  id: string;
  from_addr: string;
  recipients: string;
  data: Uint8Array;
  first_queued: number;
  attempts: number;
  last_error: string;
  dead_lettered: number;
}

/** A message the relay gave up on, retained for operator inspection / re-queue. */
export interface DeadLetterEntry {
  readonly id: string;
  readonly from: string;
  /** The recipients delivery failed for (never the ones that already succeeded). */
  readonly recipients: readonly string[];
  readonly data: Buffer;
  readonly firstQueued: number;
  readonly attempts: number;
  readonly lastError: string;
  readonly deadLettered: number;
}

export class SqliteQueue {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(db: DatabaseSync): SqliteQueue {
    db.exec(SCHEMA);
    return new SqliteQueue(db);
  }

  /** Queue a message, first attempt due at `now`. Returns the assigned id. */
  enqueue(from: string, recipients: readonly string[], data: Buffer, now: number): string {
    const id = randomUUID();
    this.#db
      .prepare('INSERT INTO outbound_queue (id, from_addr, recipients, data, first_queued, attempts, next_attempt) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, from, JSON.stringify(recipients), data, now, now);
    return id;
  }

  get size(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM outbound_queue').get() as { n: number }).n);
  }

  /** Entries whose next attempt is at or before `now`, oldest first. */
  due(now: number): readonly QueueEntry[] {
    const rows = this.#db
      .prepare('SELECT id, from_addr, recipients, data, first_queued, attempts, next_attempt FROM outbound_queue WHERE next_attempt <= ? ORDER BY first_queued')
      .all(now) as Array<{ id: string; from_addr: string; recipients: string; data: Uint8Array; first_queued: number; attempts: number; next_attempt: number }>;
    // Parse each row in isolation: a single corrupt `recipients` value (external DB
    // tampering — we always write it via JSON.stringify) must not throw out of due() and
    // halt the WHOLE queue every tick. A bad row is skipped, not fatal.
    const entries: QueueEntry[] = [];
    for (const r of rows) {
      let recipients: string[];
      try {
        recipients = JSON.parse(r.recipients) as string[];
      } catch {
        continue; // skip the poisoned row; the rest of the queue still drains
      }
      entries.push({
        id: r.id,
        from: r.from_addr,
        recipients,
        data: Buffer.from(r.data),
        firstQueued: Number(r.first_queued),
        attempts: Number(r.attempts),
        nextAttempt: Number(r.next_attempt),
      });
    }
    return entries;
  }

  /** Reschedule an entry: update the remaining recipients, attempt count, and due time. */
  reschedule(id: string, recipients: readonly string[], attempts: number, nextAttempt: number): void {
    this.#db.prepare('UPDATE outbound_queue SET recipients = ?, attempts = ?, next_attempt = ? WHERE id = ?').run(JSON.stringify(recipients), attempts, nextAttempt, id);
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(id);
  }

  /**
   * Make a live entry due immediately (`queue retry <id>`): the operator has fixed the
   * fault (network back, DNS corrected) and should not wait out the backoff. Attempt
   * count and give-up window are untouched — this only moves the due time. Returns
   * false when no live entry has that id.
   */
  retryNow(id: string, now: number): boolean {
    return Number(this.#db.prepare('UPDATE outbound_queue SET next_attempt = ? WHERE id = ?').run(now, id).changes) > 0;
  }

  /** Make EVERY live entry due immediately (`queue retry --all`). Returns how many. */
  retryAllNow(now: number): number {
    return Number(this.#db.prepare('UPDATE outbound_queue SET next_attempt = ?').run(now).changes);
  }

  /**
   * Cancel a live entry (`queue cancel <id>`): move it to the dead-letter store rather
   * than deleting it — cancellation must not be the one path that silently discards
   * bytes (the never-silently-dropped invariant). The operator can still inspect,
   * requeue, or purge it from there; purge is the only true discard. Same transactional
   * insert-then-delete guarantee as deadLetter(). Returns false when no live entry
   * has that id.
   */
  cancel(id: string, now: number): boolean {
    const row = this.#db
      .prepare('SELECT id, from_addr, recipients, data, first_queued, attempts, next_attempt FROM outbound_queue WHERE id = ?')
      .get(id) as { id: string; from_addr: string; recipients: string; data: Uint8Array; first_queued: number; attempts: number; next_attempt: number } | undefined;
    if (row === undefined) return false;
    this.#tx(() => {
      this.#db
        .prepare('INSERT INTO dead_letter (id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.from_addr, row.recipients, row.data, row.first_queued, row.attempts, 'cancelled by operator (queue cancel)', now);
      this.#db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(id);
    });
    return true;
  }

  /**
   * Run `fn` in a single transaction — all-or-nothing. A crash mid-way rolls back,
   * so we never persist half a state change. (Same pattern as the mailbox store.)
   */
  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* already rolled back / no active tx */
      }
      throw e;
    }
  }

  /**
   * Move a live queue entry to the dead-letter store: insert the retained row AND
   * delete the live row in ONE transaction. The ordering guarantee that matters —
   * insert-then-delete under a single COMMIT — means a crash at any point leaves the
   * message EITHER still live (rolled back) OR both retained and removed; it can
   * never be removed-but-not-retained, i.e. silently lost. `failedRecipients` are
   * the addresses delivery gave up on (not any that already succeeded).
   */
  deadLetter(entry: QueueEntry, opts: { readonly failedRecipients: readonly string[]; readonly lastError: string; readonly now: number }): void {
    this.#tx(() => {
      this.#db
        .prepare('INSERT INTO dead_letter (id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(entry.id, entry.from, JSON.stringify(opts.failedRecipients), entry.data, entry.firstQueued, entry.attempts, opts.lastError, opts.now);
      this.#db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(entry.id);
    });
  }

  #rowToDeadLetter(r: DeadLetterRow): DeadLetterEntry {
    let recipients: string[];
    try {
      recipients = JSON.parse(r.recipients) as string[];
    } catch {
      recipients = []; // a tampered row still lists — the bytes are what matter for recovery
    }
    return {
      id: r.id,
      from: r.from_addr,
      recipients,
      data: Buffer.from(r.data),
      firstQueued: Number(r.first_queued),
      attempts: Number(r.attempts),
      lastError: r.last_error,
      deadLettered: Number(r.dead_lettered),
    };
  }

  /** Every retained dead letter, most-recently-dead-lettered first. */
  listDeadLetters(): readonly DeadLetterEntry[] {
    const rows = this.#db
      .prepare('SELECT id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered FROM dead_letter ORDER BY dead_lettered DESC')
      .all() as unknown as DeadLetterRow[];
    return rows.map((r) => this.#rowToDeadLetter(r));
  }

  /** One dead letter by id, with byte-exact message bytes — or undefined if gone. */
  getDeadLetter(id: string): DeadLetterEntry | undefined {
    const row = this.#db
      .prepare('SELECT id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered FROM dead_letter WHERE id = ?')
      .get(id) as DeadLetterRow | undefined;
    return row === undefined ? undefined : this.#rowToDeadLetter(row);
  }

  /**
   * Re-queue a dead letter for another delivery attempt: insert a fresh live queue
   * entry (attempts reset, give-up window restarted at `now`) and delete the dead
   * letter, transactionally. Returns the new queue id, or undefined if not found.
   */
  requeueDeadLetter(id: string, now: number): string | undefined {
    const dl = this.getDeadLetter(id);
    if (dl === undefined) return undefined;
    const newId = randomUUID();
    this.#tx(() => {
      this.#db
        .prepare('INSERT INTO outbound_queue (id, from_addr, recipients, data, first_queued, attempts, next_attempt) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(newId, dl.from, JSON.stringify(dl.recipients), dl.data, now, now);
      this.#db.prepare('DELETE FROM dead_letter WHERE id = ?').run(id);
    });
    return newId;
  }

  /** Discard a dead letter permanently. */
  purgeDeadLetter(id: string): void {
    this.#db.prepare('DELETE FROM dead_letter WHERE id = ?').run(id);
  }
}
