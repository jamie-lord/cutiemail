/**
 * A reference mailbox model with IMAP UID semantics (RFC 9051 §2.3.1.1), with
 * switchable defects.
 *
 * This is the storage-layer analogue of the wire parsers: a correct-by-default
 * in-memory mailbox that pins the UID invariants (strictly ascending assignment,
 * never-reused, monotonic UIDNEXT), independent of the eventual SQLite backing.
 * Building it now lets the storage SEMANTICS be tested before the persistence
 * engine exists — and the SQLite layer, when built, must reproduce this behaviour.
 *
 * Bytes, never strings: message content is stored as the exact Buffer received.
 */

export interface StoredMessage {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  /** INTERNALDATE as an epoch-millis value (a timestamp, supplied by the caller). */
  readonly internalDate: number;
  readonly raw: Buffer;
  /**
   * The per-message modification sequence (RFC 7162 CONDSTORE). Bumped to a new,
   * higher value on every flag change and set at append; monotonic within a mailbox.
   * Lets a reconnecting client fetch only what changed since it last synced.
   */
  readonly modseq: number;
}

/**
 * Per-message metadata — everything a command needs EXCEPT the body bytes: flags, dates,
 * sizes, UID and mod-sequence. The IMAP server's cheap whole-mailbox view (index()), so a
 * metadata-only command never materialises a single message body. Defined here in the
 * storage layer (not the server) so both mailbox implementations can produce it without
 * a store→server import cycle. See docs/PERFORMANCE.md for why this split exists.
 */
export interface MessageMeta {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  /** INTERNALDATE as epoch-millis (0 = unknown). */
  readonly internalDate: number;
  /** The per-message mod-sequence (RFC 7162 CONDSTORE); monotonic within a mailbox. */
  readonly modseq: number;
  /** RFC822.SIZE in octets — so SIZE / STATUS SIZE never load the body. */
  readonly size: number;
}

/** The system flag marking a message for removal by EXPUNGE. */
export const DELETED = '\\Deleted';

export type StoreMode = 'add' | 'remove' | 'replace';

export interface MailboxDefects {
  /** Assign a UID that is not higher than existing ones (reuse the counter). Violates R-9051-2.3.1.1-a. */
  readonly nonAscendingUid?: boolean;
  /** Roll UIDNEXT back when the highest message is expunged, reusing its UID. Violates R-9051-2.3.1.1-b. */
  readonly reuseExpungedUid?: boolean;
  /** Make flag removal a no-op. Violates R-9051-2.3.2-a. */
  readonly removeDoesntClear?: boolean;
  /** Leave \Deleted messages in place on EXPUNGE. Violates R-9051-2.3.2-b. */
  readonly expungeIgnoresDeleted?: boolean;
  /** Order sequence numbers by descending UID. Violates R-9051-2.3.1.2-a. */
  readonly seqNumsDescending?: boolean;
  /** Keep an expunged message counted in sequence numbers (stale). Violates R-9051-2.3.1.2-b. */
  readonly staleSeqNumsAfterExpunge?: boolean;
  /** Allow an invalidation that does not raise UIDVALIDITY. Violates R-9051-2.3.1.1-c. */
  readonly allowNonIncreasingValidity?: boolean;
}

export class Mailbox {
  #uidValidity: number;
  #uidNext = 1;
  #messages: StoredMessage[] = [];
  /** UIDs expunged but still counted for sequence numbers (staleSeqNumsAfterExpunge only). */
  #staleUids: number[] = [];
  /** The mailbox's highest mod-sequence (RFC 7162). Nonzero even when empty. */
  #highestModseq = 1;
  /**
   * Expunged UIDs and the mod-sequence at which each was removed (RFC 7162 QRESYNC).
   * Lets a reconnecting client learn which of its cached UIDs vanished (VANISHED
   * EARLIER) in one round-trip, instead of diffing the whole UID list.
   */
  #expungedLog: { uid: number; modseq: number }[] = [];
  readonly #defects: MailboxDefects;

  constructor(uidValidity = 1, defects: MailboxDefects = {}) {
    this.#uidValidity = uidValidity;
    this.#defects = defects;
  }

  /** The UIDVALIDITY value a client uses to detect its cached UIDs have been invalidated. */
  get uidValidity(): number {
    return this.#uidValidity;
  }

  /**
   * Reassign UIDs (mailbox recreated / store rebuilt), which requires UIDVALIDITY to
   * INCREASE (R-9051-2.3.1.1-c). Returns false (and changes nothing) if `newValidity`
   * does not raise it — a client would otherwise not notice its cache is stale.
   */
  invalidate(newValidity: number): boolean {
    if (newValidity <= this.#uidValidity && this.#defects.allowNonIncreasingValidity !== true) {
      return false;
    }
    this.#uidValidity = newValidity;
    this.#messages = [];
    this.#uidNext = 1;
    this.#staleUids = [];
    this.#highestModseq = 1;
    this.#expungedLog = []; // UIDVALIDITY changed — old UIDs are meaningless now
    return true;
  }

  /** The predicted UID of the next appended message. Never decreases (conformant). */
  get uidNext(): number {
    return this.#uidNext;
  }

  /** The highest mod-sequence in the mailbox (RFC 7162 §3.1.2.2) — always nonzero. */
  get highestModseq(): number {
    return this.#highestModseq;
  }

  /** Advance and return the next mod-sequence — a strictly higher value each call. */
  #nextModseq(): number {
    this.#highestModseq += 1;
    return this.#highestModseq;
  }

  /** The messages currently in the mailbox, in arrival order. */
  get messages(): readonly StoredMessage[] {
    return this.#messages;
  }

  /**
   * Per-message metadata in mailbox (arrival = ascending-UID) order, WITHOUT body bytes —
   * the ServableMailbox view the IMAP server drives. The reference stores whole messages
   * in memory, so this is a cheap projection; the SQLite counterpart is what makes the
   * "no BLOBs for a metadata command" guarantee matter (docs/PERFORMANCE.md).
   */
  index(): readonly MessageMeta[] {
    return this.#messages.map((m) => ({ uid: m.uid, flags: m.flags, internalDate: m.internalDate, modseq: m.modseq, size: m.raw.length }));
  }

  /** One message's raw bytes by UID, or undefined if it is not present. */
  raw(uid: number): Buffer | undefined {
    return this.#messages.find((m) => m.uid === uid)?.raw;
  }

  /** Append a message, assigning it a UID. Returns the assigned UID. */
  append(raw: Buffer, flags: readonly string[] = [], internalDate = 0): number {
    const uid = this.#uidNext;
    // Conformant: advance the counter so this UID is never handed out again. The
    // nonAscendingUid defect leaves it, so the next append reuses `uid`.
    if (this.#defects.nonAscendingUid !== true) this.#uidNext = uid + 1;
    this.#messages.push({ uid, flags: new Set(flags), internalDate, raw: Buffer.from(raw), modseq: this.#nextModseq() });
    return uid;
  }

  /** Remove the message with `uid`, if present. */
  expunge(uid: number): void {
    const idx = this.#messages.findIndex((m) => m.uid === uid);
    if (idx === -1) return;
    this.#messages.splice(idx, 1);
    // An expunge gets a new mod-sequence and is logged, so QRESYNC can report it as
    // VANISHED to a client that reconnects with an older mod-sequence.
    this.#expungedLog.push({ uid, modseq: this.#nextModseq() });
    // Conformant: UIDNEXT never rolls back. The reuseExpungedUid defect rolls it
    // back when the highest-assigned UID is expunged, so the next append reuses it.
    if (this.#defects.reuseExpungedUid === true && uid === this.#uidNext - 1) {
      this.#uidNext = uid;
    }
    if (this.#defects.staleSeqNumsAfterExpunge === true) this.#staleUids.push(uid);
  }

  /**
   * UIDs expunged after `modseq` (RFC 7162 §3.2.5.2 VANISHED (EARLIER)), ascending.
   * A client that last synced at `modseq` learns exactly which of its cached UIDs are
   * gone. Optionally restricted to a set of UIDs the client actually knows about.
   */
  expungedSince(modseq: number, restrictTo?: ReadonlySet<number>): number[] {
    const uids = this.#expungedLog
      .filter((e) => e.modseq > modseq && (restrictTo === undefined || restrictTo.has(e.uid)))
      .map((e) => e.uid);
    return [...new Set(uids)].sort((a, b) => a - b);
  }

  /**
   * The 1-based message sequence number of `uid`, ordered by ascending UID
   * (R-9051-2.3.1.2). Recomputed live, so an EXPUNGE renumbers subsequent messages.
   */
  sequenceNumber(uid: number): number | null {
    const counted = [...this.#messages.map((m) => m.uid), ...this.#staleUids];
    counted.sort((a, b) => (this.#defects.seqNumsDescending === true ? b - a : a - b));
    const idx = counted.indexOf(uid);
    return idx === -1 ? null : idx + 1;
  }

  /** Replace a message's flags (a set — duplicates collapse). */
  setFlags(uid: number, flags: readonly string[]): void {
    this.storeFlags(uid, 'replace', flags);
  }

  /**
   * Apply a STORE: add (+FLAGS), remove (-FLAGS), or replace (FLAGS). Flags are a
   * set — adding a present flag is idempotent (R-9051-2.3.2-a).
   */
  storeFlags(uid: number, mode: StoreMode, flags: readonly string[]): void {
    const idx = this.#messages.findIndex((m) => m.uid === uid);
    if (idx === -1) return;
    const current = new Set(this.#messages[idx]!.flags);
    if (mode === 'replace') {
      this.#messages[idx] = { ...this.#messages[idx]!, flags: new Set(flags), modseq: this.#nextModseq() };
      return;
    }
    for (const f of flags) {
      if (mode === 'add') current.add(f);
      else if (this.#defects.removeDoesntClear !== true) current.delete(f);
    }
    this.#messages[idx] = { ...this.#messages[idx]!, flags: current, modseq: this.#nextModseq() };
  }

  /** Remove every message flagged \Deleted (R-9051-2.3.2-b). Returns the removed UIDs. */
  expungeDeleted(): readonly number[] {
    if (this.#defects.expungeIgnoresDeleted === true) return [];
    const removed = this.#messages.filter((m) => m.flags.has(DELETED)).map((m) => m.uid);
    this.#messages = this.#messages.filter((m) => !m.flags.has(DELETED));
    // One mod-sequence for the batch; log each removed UID against it (QRESYNC).
    if (removed.length > 0) {
      const m = this.#nextModseq();
      for (const uid of removed) this.#expungedLog.push({ uid, modseq: m });
    }
    return removed;
  }
}
