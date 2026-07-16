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
}

export class Mailbox {
  readonly uidValidity: number;
  #uidNext = 1;
  #messages: StoredMessage[] = [];
  readonly #defects: MailboxDefects;

  constructor(uidValidity = 1, defects: MailboxDefects = {}) {
    this.uidValidity = uidValidity;
    this.#defects = defects;
  }

  /** The predicted UID of the next appended message. Never decreases (conformant). */
  get uidNext(): number {
    return this.#uidNext;
  }

  /** The messages currently in the mailbox, in arrival order. */
  get messages(): readonly StoredMessage[] {
    return this.#messages;
  }

  /** Append a message, assigning it a UID. Returns the assigned UID. */
  append(raw: Buffer, flags: readonly string[] = [], internalDate = 0): number {
    const uid = this.#uidNext;
    // Conformant: advance the counter so this UID is never handed out again. The
    // nonAscendingUid defect leaves it, so the next append reuses `uid`.
    if (this.#defects.nonAscendingUid !== true) this.#uidNext = uid + 1;
    this.#messages.push({ uid, flags: new Set(flags), internalDate, raw: Buffer.from(raw) });
    return uid;
  }

  /** Remove the message with `uid`, if present. */
  expunge(uid: number): void {
    const idx = this.#messages.findIndex((m) => m.uid === uid);
    if (idx === -1) return;
    this.#messages.splice(idx, 1);
    // Conformant: UIDNEXT never rolls back. The reuseExpungedUid defect rolls it
    // back when the highest-assigned UID is expunged, so the next append reuses it.
    if (this.#defects.reuseExpungedUid === true && uid === this.#uidNext - 1) {
      this.#uidNext = uid;
    }
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
      this.#messages[idx] = { ...this.#messages[idx]!, flags: new Set(flags) };
      return;
    }
    for (const f of flags) {
      if (mode === 'add') current.add(f);
      else if (this.#defects.removeDoesntClear !== true) current.delete(f);
    }
    this.#messages[idx] = { ...this.#messages[idx]!, flags: current };
  }

  /** Remove every message flagged \Deleted (R-9051-2.3.2-b). Returns the removed UIDs. */
  expungeDeleted(): readonly number[] {
    if (this.#defects.expungeIgnoresDeleted === true) return [];
    const removed = this.#messages.filter((m) => m.flags.has(DELETED)).map((m) => m.uid);
    this.#messages = this.#messages.filter((m) => !m.flags.has(DELETED));
    return removed;
  }
}
