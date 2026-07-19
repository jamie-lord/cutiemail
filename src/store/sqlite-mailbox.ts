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
import { DELETED, type MessageMeta, type StoredMessage, type StoreMode } from './mailbox.ts';
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
CREATE TABLE IF NOT EXISTS expunged (
  mailbox_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  mod_seq INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, uid)
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

/**
 * Add the CONDSTORE mod-sequence columns to databases created before it existed
 * (RFC 7162). Both default to 1 — a valid nonzero starting state where every
 * pre-existing message shares mod-sequence 1 and the next change bumps to 2.
 */
function migrateModseqColumns(db: DatabaseSync): void {
  const mcols = db.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>;
  if (!mcols.some((c) => c.name === 'highest_modseq')) {
    db.exec('ALTER TABLE mailbox ADD COLUMN highest_modseq INTEGER NOT NULL DEFAULT 1');
  }
  const gcols = db.prepare("SELECT name FROM pragma_table_info('message')").all() as Array<{ name: string }>;
  if (!gcols.some((c) => c.name === 'mod_seq')) {
    db.exec('ALTER TABLE message ADD COLUMN mod_seq INTEGER NOT NULL DEFAULT 1');
  }
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
    migrateModseqColumns(db);
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

  /** The highest mod-sequence in the mailbox (RFC 7162) — always nonzero. */
  get highestModseq(): number {
    return Number((this.#db.prepare('SELECT highest_modseq FROM mailbox WHERE id = ?').get(this.#id) as { highest_modseq: number }).highest_modseq);
  }

  /** Advance and return the next mod-sequence. Must run inside a #tx (caller wraps). */
  #nextModseq(): number {
    this.#db.prepare('UPDATE mailbox SET highest_modseq = highest_modseq + 1 WHERE id = ?').run(this.#id);
    return this.highestModseq;
  }

  get messages(): readonly StoredMessage[] {
    const rows = this.#db.prepare('SELECT uid, internal_date, raw, mod_seq FROM message WHERE mailbox_id = ? ORDER BY uid').all(this.#id) as Array<{ uid: number; internal_date: number; raw: Uint8Array; mod_seq: number }>;
    const flagStmt = this.#db.prepare('SELECT flag FROM flag WHERE mailbox_id = ? AND uid = ?');
    return rows.map((r) => ({
      uid: Number(r.uid),
      internalDate: Number(r.internal_date),
      raw: Buffer.from(r.raw),
      modseq: Number(r.mod_seq),
      flags: new Set((flagStmt.all(this.#id, r.uid) as Array<{ flag: string }>).map((f) => f.flag)),
    }));
  }

  /**
   * Per-message metadata (uid, flags, internalDate, modseq, size) in ascending-UID order,
   * WITHOUT the body bytes — the ServableMailbox view the IMAP server drives on every
   * command. Two queries, no matter the mailbox size: the message rows carry LENGTH(raw)
   * (SQLite computes the octet count without transferring the BLOB), and all flags come in
   * ONE grouped query joined in memory — replacing the old `messages` getter that copied
   * every BLOB into the JS heap and ran a flag query PER message. This is the change that
   * makes FETCH 1 / STATUS / SELECT O(rows) instead of O(total mailbox bytes), so a single
   * synchronous read no longer freezes the event loop (docs/PERFORMANCE.md).
   */
  index(): readonly MessageMeta[] {
    const rows = this.#db.prepare('SELECT uid, internal_date, mod_seq, LENGTH(raw) AS size FROM message WHERE mailbox_id = ? ORDER BY uid').all(this.#id) as Array<{ uid: number; internal_date: number; mod_seq: number; size: number }>;
    const flagsByUid = new Map<number, Set<string>>();
    for (const fr of this.#db.prepare('SELECT uid, flag FROM flag WHERE mailbox_id = ?').all(this.#id) as Array<{ uid: number; flag: string }>) {
      const uid = Number(fr.uid);
      const set = flagsByUid.get(uid) ?? new Set<string>();
      set.add(fr.flag);
      flagsByUid.set(uid, set);
    }
    return rows.map((r) => ({
      uid: Number(r.uid),
      internalDate: Number(r.internal_date),
      modseq: Number(r.mod_seq),
      size: Number(r.size),
      flags: flagsByUid.get(Number(r.uid)) ?? new Set<string>(),
    }));
  }

  /** One message's raw bytes by UID, fetched as a single row (undefined if absent). */
  raw(uid: number): Buffer | undefined {
    const row = this.#db.prepare('SELECT raw FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) as { raw: Uint8Array } | undefined;
    return row === undefined ? undefined : Buffer.from(row.raw);
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
      const modseq = this.#nextModseq();
      this.#db.prepare('INSERT INTO message (mailbox_id, uid, internal_date, raw, mod_seq) VALUES (?, ?, ?, ?, ?)').run(this.#id, uid, internalDate, raw, modseq);
      const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
      for (const f of flags) ins.run(this.#id, uid, f);
      return uid;
    });
  }

  expunge(uid: number): void {
    this.#tx(() => {
      const exists = this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) !== undefined;
      this.#expungeRow(uid);
      // Log the removal against a new mod-sequence so QRESYNC can report it as VANISHED.
      if (exists) this.#db.prepare('INSERT OR REPLACE INTO expunged (mailbox_id, uid, mod_seq) VALUES (?, ?, ?)').run(this.#id, uid, this.#nextModseq());
    });
  }

  /** UIDs expunged after `modseq` (RFC 7162 QRESYNC VANISHED EARLIER), ascending. */
  expungedSince(modseq: number, restrictTo?: ReadonlySet<number>): number[] {
    const rows = this.#db.prepare('SELECT uid FROM expunged WHERE mailbox_id = ? AND mod_seq > ? ORDER BY uid').all(this.#id, modseq) as Array<{ uid: number }>;
    const uids = rows.map((r) => Number(r.uid));
    return restrictTo === undefined ? uids : uids.filter((u) => restrictTo.has(u));
  }

  storeFlags(uid: number, mode: StoreMode, flags: readonly string[]): void {
    if (this.#db.prepare('SELECT 1 FROM message WHERE mailbox_id = ? AND uid = ?').get(this.#id, uid) === undefined) return;
    this.#tx(() => {
      if (mode === 'replace') this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ?').run(this.#id, uid);
      if (mode === 'remove') {
        const del = this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ? AND uid = ? AND flag = ?');
        for (const f of flags) del.run(this.#id, uid, f);
      } else {
        const ins = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
        for (const f of flags) ins.run(this.#id, uid, f);
      }
      // A flag change bumps the message's mod-sequence (RFC 7162 §3.1.2.1).
      this.#db.prepare('UPDATE message SET mod_seq = ? WHERE mailbox_id = ? AND uid = ?').run(this.#nextModseq(), this.#id, uid);
    });
  }

  expungeDeleted(): readonly number[] {
    return this.#tx(() => {
      const rows = this.#db.prepare('SELECT uid FROM flag WHERE mailbox_id = ? AND flag = ? ORDER BY uid').all(this.#id, DELETED) as Array<{ uid: number }>;
      const uids = rows.map((r) => Number(r.uid));
      for (const uid of uids) this.#expungeRow(uid);
      // One mod-sequence for the batch; log each removed UID against it (QRESYNC).
      if (uids.length > 0) {
        const m = this.#nextModseq();
        const ins = this.#db.prepare('INSERT OR REPLACE INTO expunged (mailbox_id, uid, mod_seq) VALUES (?, ?, ?)');
        for (const uid of uids) ins.run(this.#id, uid, m);
      }
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
      this.#db.prepare('DELETE FROM expunged WHERE mailbox_id = ?').run(this.#id); // old UIDs meaningless
      this.#db.prepare('UPDATE mailbox SET uid_validity = ?, uid_next = 1, highest_modseq = 1 WHERE id = ?').run(newValidity, this.#id);
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
    migrateModseqColumns(db);
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
      // Delete the expunge tombstones too (as invalidate() does). create() reuses a freed
      // internal id via MAX(id)+1, so an orphaned expunge log would leak into the next mailbox
      // that reuses this id — a QRESYNC client would be told a LIVE message it just received in
      // the new mailbox had VANISHED, and HIGHESTMODSEQ >= every tombstone's mod_seq breaks
      // (audit run-7). MemoryCatalog builds a fresh log, so the test suite was blind to this.
      this.#db.prepare('DELETE FROM expunged WHERE mailbox_id = ?').run(id);
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
        // Renaming INBOX creates a FRESH target holding INBOX's messages and leaves INBOX in
        // place (empty). "Fresh" is the decided semantics (ADR 0016), matching the MemoryCatalog
        // reference exactly: the target reassigns UIDs from 1, starts its mod-sequence at 1
        // (so the moved messages get mod_seq 2..N+1), and has an EMPTY expunge log — nothing has
        // been expunged FROM the target; its messages are all live. The former code REPARENTED
        // (kept UIDs, carried INBOX's high modseq) and, worse, MOVED INBOX's expunge log onto the
        // target — so on a second consecutive INBOX rename the pre-existing tombstones migrated
        // away and INBOX was left telling a QRESYNC client "nothing vanished" while its cached
        // UIDs were gone (audit run-8 residual). Both bugs die with the fresh-target rebuild.
        const nextId = Number((this.#db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM mailbox').get() as { id: number }).id);
        const inbox = this.#db.prepare('SELECT uid_validity, highest_modseq FROM mailbox WHERE id = ?').get(Number(src.id)) as { uid_validity: number; highest_modseq: number };
        const moving = this.#db.prepare('SELECT uid, internal_date, raw FROM message WHERE mailbox_id = ? ORDER BY uid').all(Number(src.id)) as Array<{ uid: number; internal_date: number; raw: Uint8Array }>;
        const n = moving.length;
        // The target: fresh UID space and mod-sequence (uid_next = highest_modseq = n+1, both 1
        // when empty), same UIDVALIDITY as the catalog (INBOX's).
        this.#db.prepare('INSERT INTO mailbox (id, uid_validity, uid_next, name, highest_modseq) VALUES (?, ?, ?, ?, ?)').run(nextId, Number(inbox.uid_validity), n + 1, ct, n + 1);
        const flagsOf = this.#db.prepare('SELECT flag FROM flag WHERE mailbox_id = ? AND uid = ?');
        const insMsg = this.#db.prepare('INSERT INTO message (mailbox_id, uid, internal_date, raw, mod_seq) VALUES (?, ?, ?, ?, ?)');
        const insFlag = this.#db.prepare('INSERT OR IGNORE INTO flag (mailbox_id, uid, flag) VALUES (?, ?, ?)');
        moving.forEach((m, i) => {
          const newUid = i + 1; // reassigned from 1, preserving arrival (UID) order
          insMsg.run(nextId, newUid, Number(m.internal_date), Buffer.from(m.raw), i + 2); // mod_seq 2..n+1
          for (const f of flagsOf.all(Number(src.id), Number(m.uid)) as Array<{ flag: string }>) insFlag.run(nextId, newUid, f.flag);
        });
        // Empty INBOX of the moved rows.
        this.#db.prepare('DELETE FROM flag WHERE mailbox_id = ?').run(Number(src.id));
        this.#db.prepare('DELETE FROM message WHERE mailbox_id = ?').run(Number(src.id));
        // Report the moved (ORIGINAL) UIDs as VANISHED on the now-empty source INBOX: bump INBOX's
        // highest_modseq and log each as expunged, so a QRESYNC/CONDSTORE client reconnecting to
        // INBOX learns its cached messages are gone (audit run-7). INBOX's PRE-EXISTING tombstones
        // are left untouched — they are part of INBOX's vanished history and must not migrate.
        let modseq = Number(inbox.highest_modseq);
        const logVanished = this.#db.prepare('INSERT OR REPLACE INTO expunged (mailbox_id, uid, mod_seq) VALUES (?, ?, ?)');
        for (const m of moving) logVanished.run(Number(src.id), Number(m.uid), ++modseq);
        if (n > 0) this.#db.prepare('UPDATE mailbox SET highest_modseq = ? WHERE id = ?').run(modseq, Number(src.id));
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
