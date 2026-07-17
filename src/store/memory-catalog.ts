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

  constructor(uidValidity = 1) {
    this.#uidValidity = uidValidity;
    this.#boxes.set('INBOX', new Mailbox(uidValidity));
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
    const box = new Mailbox(this.#uidValidity);
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
