/**
 * Mailbox change notification — the seam that makes IMAP IDLE work.
 *
 * IDLE (RFC 2177 / RFC 9051 §6.3.13) lets a client hold a connection open and be
 * told the instant a mailbox changes, instead of polling. That requires the
 * inbound SMTP path (which appends new mail) to reach across to the IMAP
 * connections idling on that mailbox. This is that pub/sub, keyed by canonical
 * mailbox name: the daemon notifies "INBOX" after an inbound delivery, and every
 * idling connection selected on INBOX wakes and pushes an untagged EXISTS.
 *
 * Deliberately tiny and synchronous — one process, one event loop; there is no
 * cross-process story yet, and inventing one would be scope this server doesn't
 * need.
 */

import { canonicalMailboxName } from '../store/mailbox-name.ts';

export class MailboxNotifier {
  readonly #listeners = new Map<string, Set<() => void>>();

  /** Subscribe to changes on a mailbox. Returns an unsubscribe function. */
  subscribe(mailbox: string, fn: () => void): () => void {
    const name = canonicalMailboxName(mailbox);
    let set = this.#listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(name, set);
    }
    set.add(fn);
    return () => {
      const s = this.#listeners.get(name);
      if (s === undefined) return;
      s.delete(fn);
      if (s.size === 0) this.#listeners.delete(name);
    };
  }

  /** Notify all subscribers of a mailbox that it changed. */
  notify(mailbox: string): void {
    const set = this.#listeners.get(canonicalMailboxName(mailbox));
    if (set === undefined) return;
    for (const fn of [...set]) fn();
  }
}
