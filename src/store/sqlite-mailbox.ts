/**
 * The SQLite-backed mailbox — the real storage implementation of the semantics the
 * reference mailbox (src/store/mailbox.ts) specifies.
 *
 * This is where "SQLite of email" becomes literal: messages, flags, and the UID
 * bookkeeping live in SQLite via the built-in node:sqlite (zero external deps). It
 * exposes the same surface as the reference Mailbox, and the conformance test drives
 * BOTH through one shared invariant harness — so the persistent implementation must
 * reproduce the reference behaviour exactly (UID monotonicity, no reuse, flag/STORE,
 * EXPUNGE, sequence numbers, UIDVALIDITY), and it must survive a close/reopen.
 *
 * Bytes, never strings: message content is stored as a BLOB and returned byte-exact.
 */

import { DatabaseSync } from 'node:sqlite';
import { DELETED, type StoredMessage, type StoreMode } from './mailbox.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY,
  uid_validity INTEGER NOT NULL,
  uid_next INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  mailbox_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  internal_date INTEGER NOT NULL,
  raw BLOB NOT NULL,
  PRIMARY KEY (mailbox_id, uid)
);
CREATE TABLE IF NOT EXISTS flag (
  mailbox_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  flag TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, uid, flag)
);
`;

export class SqliteMailbox {
  readonly #db: DatabaseSync;
  readonly #id: number;

  private constructor(db: DatabaseSync, id: number) {
    this.#db = db;
    this.#id = id;
  }

  /** Open (or create) a mailbox in the given database (":memory:" or a file path). */
  static open(db: DatabaseSync, uidValidity = 1, id = 1): SqliteMailbox {
    db.exec(SCHEMA);
    const existing = db.prepare('SELECT id FROM mailbox WHERE id = ?').get(id);
    if (existing === undefined) {
      db.prepare('INSERT INTO mailbox (id, uid_validity, uid_next) VALUES (?, ?, 1)').run(id, uidValidity);
    }
    return new SqliteMailbox(db, id);
  }

  get uidValidity(): number {
    return Number((this.#db.prepare('SELECT uid_validity FROM mailbox WHERE id = ?').get(this.#id) as { uid_validity: number }).uid_validity);
  }

  get uidNext(): number {
    return Number((this.#db.prepare('SELECT uid_next FROM mailbox WHERE id = ?').get(this.#id) as { uid_next: number }).uid_next);
  }

  get messages(): readonly StoredMessage[] {
    const rows = this.#db.prepare('SELECT uid, internal_date, raw FROM message WHERE mailbox_id = ? ORDER BY uid').all(this.#id) as Array<{ uid: number; internal_date: number; raw: Uint8Array }>;
    const flagStmt = this.#db.prepare('SELECT flag FROM flag WHERE mailbox_id = ? AND uid = ?');
    return rows.map((r) => ({
      uid: Number(r.uid),
      internalDate: Number(r.internal_date),
      raw: Buffer.from(r.raw),
      flags: new Set((flagStmt.all(this.#id, r.uid) as Array<{ flag: string }>).map((f) => f.flag)),
    }));
  }

  append(raw: Buffer, flags: readonly string[] = [], internalDate = 0): number {
    const uid = this.uidNext;
    this.#db.prepare('UPDATE mailbox SET uid_next = ? WHERE id = ?').run(uid + 1, this.#id);
    this.#db.prepare('INSERT INTO message (mailbox_id, uid, internal_date, raw) VALUES (?, ?, ?, ?)').run(this.#id, uid, internalDate, raw);
    const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
    for (const f of flags) ins.run(this.#id, uid, f);
    return uid;
  }

  expunge(uid: number): void {
    this.#db.prepare('DELETE FROM message WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
    this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
  }

  storeFlags(uid: number, mode: StoreMode, flags: readonly string[]): void {
    if (this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) === undefined) return;
    if (mode === 'replace') this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
    if (mode === 'remove') {
      const del = this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ? AND flag = ?');
      for (const f of flags) del.run(this.#id, uid, f);
      return;
    }
    const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
    for (const f of flags) ins.run(this.#id, uid, f);
  }

  expungeDeleted(): readonly number[] {
    const rows = this.#db.prepare('SELECT uid FROM flag WHERE mailbox_id = ? AND flag = ? ORDER BY uid').all(this.#id, DELETED) as Array<{ uid: number }>;
    const uids = rows.map((r) => Number(r.uid));
    for (const uid of uids) this.expunge(uid);
    return uids;
  }

  /** 1-based position ordered by ascending UID (null if the UID is not present). */
  sequenceNumber(uid: number): number | null {
    if (this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) === undefined) return null;
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM message WHERE mailbox_id = ? AND uid <= ?').get(this.#id, uid) as { n: number };
    return Number(row.n);
  }

  invalidate(newValidity: number): boolean {
    if (newValidity <= this.uidValidity) return false;
    this.#db.prepare('DELETE FROM message WHERE mailbox_id = ?').run(this.#id);
    this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ?').run(this.#id);
    this.#db.prepare('UPDATE mailbox SET uid_validity = ?, uid_next = 1 WHERE id = ?').run(newValidity, this.#id);
    return true;
  }
}
