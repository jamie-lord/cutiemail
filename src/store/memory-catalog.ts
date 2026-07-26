/**
 * The in-memory mailbox catalog — the reference counterpart of SqliteCatalog,
 * used by tests and anywhere a throwaway multi-folder store is needed. Same
 * naming semantics: INBOX always exists and matches case-insensitively
 * (RFC 9051 §5.1); other names are exact.
 */

import { Mailbox } from './mailbox.ts';
import { canonicalMailboxName, subtreeRenames } from './mailbox-name.ts';

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
   * Rename a mailbox (RFC 9051 §6.3.6). Renaming INBOX moves its messages into a new
   * target and leaves INBOX in place (emptied); INBOX is never deleted.
   */
  rename(from: string, to: string): 'ok' | 'notfound' | 'exists' {
    const cf = canonicalMailboxName(from);
    const ct = canonicalMailboxName(to);
    const src = this.#boxes.get(cf);
    if (src === undefined) return 'notfound';
    if (this.#boxes.has(ct)) return 'exists';
    if (cf === 'INBOX') {
      // "If the server implementation supports inferior hierarchical names of INBOX, these are
      // unaffected by a rename of INBOX" (§6.3.6). So the subtree walk below must NOT run here:
      // INBOX/sub stays exactly where it is while INBOX's messages move out.
      const dest = new Mailbox(this.#uidValidity);
      const moving = [...src.messages];
      for (const m of moving) dest.append(m.raw, [...m.flags], m.internalDate);
      for (const m of moving) src.expunge(m.uid); // empty INBOX, which keeps existing
      this.#boxes.set(ct, dest);
      return 'ok';
    }
    const moves = subtreeRenames(cf, ct, this.listNames());
    // Every destination must be free, the inferior ones included. Checking only the named target
    // would let `RENAME foo baz` succeed while foo/bar had nowhere to land — and the RFC's own
    // wording covers this: it is an error to rename to a name that already exists, and baz/bar
    // does exist at the moment of the command. Refusing up front also makes the loop below
    // collision-free in any order, since no destination is any current name.
    if (moves.some(([, dest]) => this.#boxes.has(dest))) return 'exists';
    for (const [oldName, newName] of moves) {
      const box = this.#boxes.get(oldName);
      if (box === undefined) continue;
      this.#boxes.delete(oldName);
      this.#boxes.set(newName, box);
    }
    return 'ok';
  }
}
