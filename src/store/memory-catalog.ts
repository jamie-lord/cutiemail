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
}
