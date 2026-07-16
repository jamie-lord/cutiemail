/**
 * A reference outbound delivery queue with retry semantics (RFC 5321 §4.5.4.1),
 * with switchable defects.
 *
 * The state machine behind the send leg: a message that can't be delivered now is
 * queued and periodically retried with a growing backoff, permanent failures bounce
 * immediately, and after a give-up window a still-undelivered message bounces. This
 * is a reference model (time is injected as `now`), testable before the SQLite-backed
 * queue exists — which, when built, must reproduce this behaviour.
 *
 * The §4.5.4.1 requirements bind the CLIENT and are `not-testable` from the receiver
 * conformance suite's seat; this reference model is how they become checkable, the
 * same way the outbound client harness (ADR 0008) covers the send-path wire rules.
 */

export type AttemptOutcome = 'success' | 'transient' | 'permanent';
export type QueueDecision = 'delivered' | 'retry' | 'bounced';

/** Minimum retry delay (RFC 5321 §4.5.4.1-c SHOULD: at least 30 minutes). */
export const MIN_RETRY_MS = 30 * 60 * 1000;
/** Give-up window (§4.5.4.1-d: at least 4-5 days). */
export const GIVE_UP_MS = 5 * 24 * 60 * 60 * 1000;

export interface QueuedMessage {
  readonly id: string;
  readonly firstQueued: number;
  attempts: number;
  nextAttempt: number;
}

export interface QueueDefects {
  /** Retry a transient failure with no delay. Violates R-5321-4.5.4.1-b. */
  readonly retryWithoutDelay?: boolean;
  /** Treat a permanent (5yz) failure as retryable instead of bouncing. */
  readonly retryOnPermanent?: boolean;
  /** Never give up — retry forever past the give-up window. Violates R-5321-4.5.4.1-d. */
  readonly neverGiveUp?: boolean;
}

export class DeliveryQueue {
  readonly #messages = new Map<string, QueuedMessage>();
  readonly #defects: QueueDefects;

  constructor(defects: QueueDefects = {}) {
    this.#defects = defects;
  }

  /** Queue a message for delivery, first attempt due now. */
  enqueue(id: string, now: number): void {
    this.#messages.set(id, { id, firstQueued: now, attempts: 0, nextAttempt: now });
  }

  get size(): number {
    return this.#messages.size;
  }

  has(id: string): boolean {
    return this.#messages.has(id);
  }

  peek(id: string): QueuedMessage | undefined {
    return this.#messages.get(id);
  }

  /** Messages whose nextAttempt is at or before `now`. */
  due(now: number): readonly QueuedMessage[] {
    return [...this.#messages.values()].filter((m) => m.nextAttempt <= now);
  }

  /** Backoff for the Nth attempt: exponential, floored at the minimum retry delay. */
  backoffMs(attempts: number): number {
    return MIN_RETRY_MS * 2 ** Math.max(0, attempts - 1);
  }

  /** Record a delivery attempt's outcome and decide what happens to the message. */
  recordAttempt(id: string, outcome: AttemptOutcome, now: number): QueueDecision {
    const msg = this.#messages.get(id);
    if (msg === undefined) return 'delivered';
    msg.attempts += 1;

    if (outcome === 'success') {
      this.#messages.delete(id);
      return 'delivered';
    }

    if (outcome === 'permanent' && this.#defects.retryOnPermanent !== true) {
      this.#messages.delete(id); // 5yz -> bounce, do not retry
      return 'bounced';
    }

    // Transient (or a permanent one the defect keeps): retry unless past give-up.
    const expired = now - msg.firstQueued >= GIVE_UP_MS;
    if (expired && this.#defects.neverGiveUp !== true) {
      this.#messages.delete(id);
      return 'bounced';
    }

    msg.nextAttempt = this.#defects.retryWithoutDelay === true ? now : now + this.backoffMs(msg.attempts);
    return 'retry';
  }
}
