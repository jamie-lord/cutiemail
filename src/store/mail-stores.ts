/**
 * A cache of per-user mail stores, keyed by login (ADR 0009).
 *
 * All of one user's IMAP connections AND that user's inbound deliveries must share ONE
 * catalog + notifier instance — otherwise IDLE push (the delivery path notifies the
 * connections idling on INBOX) and multi-connection sync (two of the user's clients
 * reconciling each other's changes) both break. So `get` opens a user's store at most
 * once and returns the same live instance forever after.
 *
 * The opener is injected: production opens `mail-<login>.db` and provisions the
 * special-use folders; tests hand back an in-memory catalog. The opener also owns the
 * "unknown or disabled account → undefined" decision (it consults the registry).
 */

import type { ServableCatalog } from '../server/imap-server.ts';
import type { MailboxNotifier } from '../server/mailbox-notifier.ts';

export interface UserMailStore {
  readonly catalog: ServableCatalog;
  readonly notifier: MailboxNotifier;
  /** Release resources (close the underlying database). Absent for in-memory stores. */
  close?(): void;
}

export class MailStores {
  readonly #cache = new Map<string, UserMailStore>();
  readonly #open: (login: string) => UserMailStore | undefined;

  constructor(open: (login: string) => UserMailStore | undefined) {
    this.#open = open;
  }

  /**
   * The live store for a login, opening it on first use and caching it thereafter.
   * Returns undefined for an unknown or disabled account (the opener decides).
   */
  get(login: string): UserMailStore | undefined {
    const cached = this.#cache.get(login);
    if (cached !== undefined) return cached;
    const opened = this.#open(login);
    if (opened === undefined) return undefined;
    this.#cache.set(login, opened);
    return opened;
  }

  /** Close every opened store (daemon shutdown). */
  closeAll(): void {
    for (const s of this.#cache.values()) s.close?.();
    this.#cache.clear();
  }
}
