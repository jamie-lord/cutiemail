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
import { canonicalMailboxName } from './mailbox-name.ts';

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

/** Add the name column to databases created before multi-mailbox existed. */
function migrateNameColumn(db: DatabaseSync): void {
  const cols = db.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'name')) {
    db.exec("ALTER TABLE mailbox ADD COLUMN name TEXT NOT NULL DEFAULT 'INBOX'");
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS mailbox_name ON mailbox (name)');
}

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
    migrateNameColumn(db);
    const existing = db.prepare('SELECT id FROM mailbox WHERE id = ?').get(id);
    if (existing === undefined) {
      // id 1 is INBOX by convention; other bare opens get a synthetic unique name.
      db.prepare('INSERT INTO mailbox (id, uid_validity, uid_next, name) VALUES (?, ?, 1, ?)').run(id, uidValidity, id === 1 ? 'INBOX' : `mailbox-${id}`);
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

  /**
   * Run `fn` in a single transaction: a multi-statement mutation commits all-or-
   * nothing (a crash mid-way can't leave half a message stored) and costs one
   * fsync instead of one per statement. Not nested — our callers never nest.
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

  /** Delete a message and its flags (no transaction — callers wrap). */
  #expungeRow(uid: number): void {
    this.#db.prepare('DELETE FROM message WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
    this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
  }

  append(raw: Buffer, flags: readonly string[] = [], internalDate = 0): number {
    return this.#tx(() => {
      const uid = this.uidNext;
      this.#db.prepare('UPDATE mailbox SET uid_next = ? WHERE id = ?').run(uid + 1, this.#id);
      this.#db.prepare('INSERT INTO message (mailbox_id, uid, internal_date, raw) VALUES (?, ?, ?, ?)').run(this.#id, uid, internalDate, raw);
      const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
      for (const f of flags) ins.run(this.#id, uid, f);
      return uid;
    });
  }

  expunge(uid: number): void {
    this.#tx(() => this.#expungeRow(uid));
  }

  storeFlags(uid: number, mode: StoreMode, flags: readonly string[]): void {
    if (this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) === undefined) return;
    this.#tx(() => {
      if (mode === 'replace') this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
      if (mode === 'remove') {
        const del = this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ? AND flag = ?');
        for (const f of flags) del.run(this.#id, uid, f);
        return;
      }
      const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
      for (const f of flags) ins.run(this.#id, uid, f);
    });
  }

  expungeDeleted(): readonly number[] {
    return this.#tx(() => {
      const rows = this.#db.prepare('SELECT uid FROM flag WHERE mailbox_id = ? AND flag = ? ORDER BY uid').all(this.#id, DELETED) as Array<{ uid: number }>;
      const uids = rows.map((r) => Number(r.uid));
      for (const uid of uids) this.#expungeRow(uid);
      return uids;
    });
  }

  /** 1-based position ordered by ascending UID (null if the UID is not present). */
  sequenceNumber(uid: number): number | null {
    if (this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) === undefined) return null;
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM message WHERE mailbox_id = ? AND uid <= ?').get(this.#id, uid) as { n: number };
    return Number(row.n);
  }

  invalidate(newValidity: number): boolean {
    if (newValidity <= this.uidValidity) return false;
    this.#tx(() => {
      this.#db.prepare('DELETE FROM message WHERE mailbox_id = ?').run(this.#id);
      this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ?').run(this.#id);
      this.#db.prepare('UPDATE mailbox SET uid_validity = ?, uid_next = 1 WHERE id = ?').run(newValidity, this.#id);
    });
    return true;
  }
}

/**
 * The catalog of named mailboxes in one database — what multi-folder IMAP
 * (LIST/CREATE/SELECT-by-name, Trash/Sent) serves. INBOX always exists; other
 * names are created on demand (a real Thunderbird's first act is CREATE "Trash").
 * Name matching is INBOX-case-insensitive per RFC 9051 §5.1 (canonicalMailboxName).
 */
export class SqliteCatalog {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(db: DatabaseSync, uidValidity = 1): SqliteCatalog {
    db.exec(SCHEMA);
    migrateNameColumn(db);
    const cat = new SqliteCatalog(db);
    if (cat.get('INBOX') === undefined) cat.create('INBOX', uidValidity);
    return cat;
  }

  listNames(): readonly string[] {
    const rows = this.#db.prepare('SELECT name FROM mailbox ORDER BY id').all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  get(name: string): SqliteMailbox | undefined {
    const canon = canonicalMailboxName(name);
    const row = this.#db.prepare('SELECT id FROM mailbox WHERE name = ?').get(canon) as { id: number } | undefined;
    return row === undefined ? undefined : SqliteMailbox.open(this.#db, 1, Number(row.id));
  }

  /** Create a mailbox. Returns undefined if the name already exists. */
  create(name: string, uidValidity = 1): SqliteMailbox | undefined {
    const canon = canonicalMailboxName(name);
    if (this.get(canon) !== undefined) return undefined;
    const next = this.#db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM mailbox').get() as { id: number };
    this.#db.prepare('INSERT INTO mailbox (id, uid_validity, uid_next, name) VALUES (?, ?, 1, ?)').run(Number(next.id), uidValidity, canon);
    return SqliteMailbox.open(this.#db, uidValidity, Number(next.id));
  }

  /** Delete a mailbox and its messages/flags. False if absent or INBOX (RFC 9051 §6.3.4). */
  delete(name: string): boolean {
    const canon = canonicalMailboxName(name);
    if (canon === 'INBOX') return false;
    const row = this.#db.prepare('SELECT id FROM mailbox WHERE name = ?').get(canon) as { id: number } | undefined;
    if (row === undefined) return false;
    const id = Number(row.id);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ?').run(id);
      this.#db.prepare('DELETE FROM message WHERE mailbox_id = ?').run(id);
      this.#db.prepare('DELETE FROM mailbox WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return true;
  }

  /**
   * Rename a mailbox (RFC 9051 §6.3.5). Renaming INBOX is special: its messages move
   * into a newly created target and INBOX itself stays (now empty) — INBOX is never
   * deleted. A plain mailbox is renamed in place.
   */
  rename(from: string, to: string): 'ok' | 'notfound' | 'exists' {
    const cf = canonicalMailboxName(from);
    const ct = canonicalMailboxName(to);
    const src = this.#db.prepare('SELECT id FROM mailbox WHERE name = ?').get(cf) as { id: number } | undefined;
    if (src === undefined) return 'notfound';
    if (this.#db.prepare('SELECT 1 FROM mailbox WHERE name = ?').get(ct) !== undefined) return 'exists';
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (cf === 'INBOX') {
        // Move INBOX's rows to a fresh mailbox, keeping their UIDs; leave INBOX empty.
        const nextId = Number((this.#db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM mailbox').get() as { id: number }).id);
        const inboxUidNext = Number((this.#db.prepare('SELECT uid_next FROM mailbox WHERE id = ?').get(Number(src.id)) as { uid_next: number }).uid_next);
        this.#db.prepare('INSERT INTO mailbox (id, uid_validity, uid_next, name) VALUES (?, 1, ?, ?)').run(nextId, inboxUidNext, ct);
        this.#db.prepare('UPDATE message SET mailbox_id = ? WHERE mailbox_id = ?').run(nextId, Number(src.id));
        this.#db.prepare('UPDATE flag SET mailbox_id = ? WHERE mailbox_id = ?').run(nextId, Number(src.id));
      } else {
        this.#db.prepare('UPDATE mailbox SET name = ? WHERE id = ?').run(ct, Number(src.id));
      }
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return 'ok';
  }
}
