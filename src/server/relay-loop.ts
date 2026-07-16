/**
 * The relay loop — drains the outbound queue, retrying on the shared schedule.
 *
 * `tick(now)` processes every due entry once: relay to its remaining recipients,
 * settle the ones that delivered or permanently bounced, and reschedule the rest
 * on `decideRetry`'s backoff (or bounce them once the give-up window passes). Time
 * is a parameter, exactly like the reference queue — tests drive `tick` with a
 * controlled clock; the daemon calls it on a timer and once immediately after each
 * enqueue so the first attempt isn't delayed.
 *
 * Per-recipient bookkeeping matters: only recipients that still need retrying are
 * carried forward, so a partially-delivered message is never re-sent to those who
 * already got it.
 */

import { decideRetry, type QueueDefects } from '../store/queue.ts';
import type { SqliteQueue, QueueEntry } from '../store/sqlite-queue.ts';
import type { RelayResult } from './outbound.ts';

export interface RelayFn {
  (msg: { from: string; recipients: readonly string[]; data: Buffer }): Promise<readonly RelayResult[]>;
}

export interface RelayLoopOptions {
  readonly log?: (line: string) => void;
  readonly defects?: QueueDefects;
}

export class RelayLoop {
  readonly #queue: SqliteQueue;
  readonly #relay: RelayFn;
  readonly #log: (line: string) => void;
  readonly #defects: QueueDefects;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(queue: SqliteQueue, relay: RelayFn, options: RelayLoopOptions = {}) {
    this.#queue = queue;
    this.#relay = relay;
    this.#log = options.log ?? ((): void => {});
    this.#defects = options.defects ?? {};
  }

  /** Process every entry due at `now`. Safe against re-entrancy (a slow tick won't overlap). */
  async tick(now: number): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const entry of this.#queue.due(now)) {
        await this.#processEntry(entry, now);
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #processEntry(entry: QueueEntry, now: number): Promise<void> {
    let results: readonly RelayResult[];
    try {
      results = await this.#relay({ from: entry.from, recipients: entry.recipients, data: entry.data });
    } catch (e) {
      this.#log(`queue ${entry.id}: relay error — ${String(e)}`);
      return; // leave it queued; next tick retries
    }

    const retryLater: string[] = [];
    for (const r of results) {
      if (r.classification === 'transient') retryLater.push(r.recipient);
      else this.#log(`queue ${entry.id} ${r.recipient}: ${r.ok ? 'sent' : 'bounced'} — ${r.detail}`);
    }

    const attempts = entry.attempts + 1;
    if (retryLater.length === 0) {
      this.#queue.remove(entry.id);
      return;
    }
    const { decision, nextAttempt } = decideRetry(attempts, entry.firstQueued, 'transient', now, this.#defects);
    if (decision === 'retry') {
      this.#queue.reschedule(entry.id, retryLater, attempts, nextAttempt);
    } else {
      for (const rcpt of retryLater) this.#log(`queue ${entry.id} ${rcpt}: bounced (gave up after ${attempts} attempts)`);
      this.#queue.remove(entry.id);
    }
  }

  /** Start ticking on an interval. `clock` defaults to the real clock. */
  start(intervalMs: number, clock: () => number = () => Date.now()): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(clock()), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
