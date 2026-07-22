/**
 * The in-memory mailbox catalog — the reference counterpart of SqliteCatalog,
 * used by tests and anywhere a throwaway multi-folder store is needed. Same
 * naming semantics: INBOX always exists and matches case-insensitively
 * (RFC 9051 §5.1); other names are exact.
 */

import { Mailbox } from './mailbox.ts';
import { canonicalMailboxName } from './mailbox-name.ts';

export class MemoryCatalog {
  readonly #boxes = new Map<string, Mailbox>();
  readonly #uidValidity: number;
  /**
   * The highest UIDVALIDITY ever assigned by this catalog — a monotonic high-water mark, so
   * a mailbox CREATEd after another was DELETEd never reuses the deleted incarnation's
   * (UIDVALIDITY, UID) space (RFC 9051 §6.3.4 MUST). Without this, DELETE Work then CREATE Work
   * handed the new mailbox UIDVALIDITY 1 and UIDs from 1 again, so an offline-caching client
   * showed stale cached bodies against the recycled (UIDVALIDITY, UID) pairs. Seeded to the
   * catalog's initial UIDVALIDITY; every create() bumps it. Kept in lockstep with SqliteCatalog.
   */
  #uidValidityHwm: number;

  constructor(uidValidity = 1) {
    this.#uidValidity = uidValidity;
    this.#uidValidityHwm = uidValidity;
    this.#boxes.set('INBOX', new Mailbox(uidValidity));
  }

  /** Advance and return the next UIDVALIDITY — strictly greater than any previously assigned. */
  #nextUidValidity(): number {
    this.#uidValidityHwm += 1;
    return this.#uidValidityHwm;
  }

  listNames(): readonly string[] {
    return [...this.#boxes.keys()];
  }

  get(name: string): Mailbox | undefined {
    return this.#boxes.get(canonicalMailboxName(name));
  }

  /** Create a mailbox. Returns undefined if the name already exists. */
  create(name: string): Mailbox | undefined {
    const canon = canonicalMailboxName(name);
    if (this.#boxes.has(canon)) return undefined;
    // A monotonic UIDVALIDITY (never the catalog's seed value again), so a recreated name
    // cannot reuse a prior incarnation's (UIDVALIDITY, UID) space — RFC 9051 §6.3.4.
    const box = new Mailbox(this.#nextUidValidity());
    this.#boxes.set(canon, box);
    return box;
  }

  /** Delete a mailbox. False if absent or INBOX (RFC 9051 §6.3.4). */
  delete(name: string): boolean {
    const canon = canonicalMailboxName(name);
    if (canon === 'INBOX' || !this.#boxes.has(canon)) return false;
    this.#boxes.delete(canon);
    return true;
  }

  /**
   * Rename a mailbox (RFC 9051 §6.3.5). Renaming INBOX moves its messages into a new
   * target and leaves INBOX in place (emptied); INBOX is never deleted.
   */
  rename(from: string, to: string): 'ok' | 'notfound' | 'exists' {
    const cf = canonicalMailboxName(from);
    const ct = canonicalMailboxName(to);
    const src = this.#boxes.get(cf);
    if (src === undefined) return 'notfound';
    if (this.#boxes.has(ct)) return 'exists';
    if (cf === 'INBOX') {
      const dest = new Mailbox(this.#uidValidity);
      const moving = [...src.messages];
      for (const m of moving) dest.append(m.raw, [...m.flags], m.internalDate);
      for (const m of moving) src.expunge(m.uid); // empty INBOX, which keeps existing
      this.#boxes.set(ct, dest);
    } else {
      this.#boxes.delete(cf);
      this.#boxes.set(ct, src);
    }
    return 'ok';
  }
}
