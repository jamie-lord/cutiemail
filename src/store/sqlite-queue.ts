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
    return rows.map((r) => ({
      id: r.id,
      from: r.from_addr,
      recipients: JSON.parse(r.recipients) as string[],
      data: Buffer.from(r.data),
      firstQueued: Number(r.first_queued),
      attempts: Number(r.attempts),
      nextAttempt: Number(r.next_attempt),
    }));
  }

  /** Reschedule an entry: update the remaining recipients, attempt count, and due time. */
  reschedule(id: string, recipients: readonly string[], attempts: number, nextAttempt: number): void {
    this.#db.prepare('UPDATE outbound_queue SET recipients = ?, attempts = ?, next_attempt = ? WHERE id = ?').run(JSON.stringify(recipients), attempts, nextAttempt, id);
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(id);
  }
}
