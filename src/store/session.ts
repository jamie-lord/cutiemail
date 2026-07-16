/**
 * A reference IMAP mailbox session (RFC 9051 §6.3.3), with a defect.
 *
 * Wraps a Mailbox with the session-level read-only property that EXAMINE
 * establishes: reads always work, but every mutation is refused on a read-only
 * session, leaving the mailbox untouched. Read-only is per-session — the same
 * mailbox may be open read-write elsewhere — so it lives here, not on the Mailbox.
 */

import type { Mailbox, StoreMode } from './mailbox.ts';

export interface SessionDefects {
  /** Let a mutation through on a read-only session. Violates R-9051-6.3.3-a. */
  readonly allowWriteWhenReadOnly?: boolean;
}

export class MailboxSession {
  readonly #mailbox: Mailbox;
  readonly #readOnly: boolean;
  readonly #defects: SessionDefects;

  constructor(mailbox: Mailbox, readOnly: boolean, defects: SessionDefects = {}) {
    this.#mailbox = mailbox;
    this.#readOnly = readOnly;
    this.#defects = defects;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  /** The underlying mailbox — reads are always permitted. */
  get mailbox(): Mailbox {
    return this.#mailbox;
  }

  /** True if a write is permitted right now (read-write session, or the defect is on). */
  #mayWrite(): boolean {
    return !this.#readOnly || this.#defects.allowWriteWhenReadOnly === true;
  }

  /** Append a message. Refused (returns null) on a read-only session. */
  append(raw: Buffer, flags: readonly string[] = [], internalDate = 0): number | null {
    if (!this.#mayWrite()) return null;
    return this.#mailbox.append(raw, flags, internalDate);
  }

  /** Apply a STORE. Returns false (no change) on a read-only session. */
  storeFlags(uid: number, mode: StoreMode, flags: readonly string[]): boolean {
    if (!this.#mayWrite()) return false;
    this.#mailbox.storeFlags(uid, mode, flags);
    return true;
  }

  /** EXPUNGE \Deleted messages. Returns null (no change) on a read-only session. */
  expunge(): readonly number[] | null {
    if (!this.#mayWrite()) return null;
    return this.#mailbox.expungeDeleted();
  }
}
