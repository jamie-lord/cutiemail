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

/** Backoff for the Nth attempt: exponential, floored at the minimum retry delay. */
export function backoffMs(attempts: number): number {
  return MIN_RETRY_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * The pure retry decision (RFC 5321 §4.5.4.1): given how many attempts a message
 * has had and when it was first queued, decide what an attempt's outcome means.
 * Extracted so the SQLite-backed queue and the reference queue share ONE decision
 * — the persistent implementation cannot drift from the specified behaviour.
 * `attempts` is the count INCLUDING the attempt just made.
 */
export function decideRetry(
  attempts: number,
  firstQueued: number,
  outcome: AttemptOutcome,
  now: number,
  defects: QueueDefects = {},
): { readonly decision: QueueDecision; readonly nextAttempt: number } {
  if (outcome === 'success') return { decision: 'delivered', nextAttempt: 0 };
  if (outcome === 'permanent' && defects.retryOnPermanent !== true) {
    return { decision: 'bounced', nextAttempt: 0 }; // 5yz -> bounce, do not retry
  }
  const expired = now - firstQueued >= GIVE_UP_MS;
  if (expired && defects.neverGiveUp !== true) return { decision: 'bounced', nextAttempt: 0 };
  const nextAttempt = defects.retryWithoutDelay === true ? now : now + backoffMs(attempts);
  return { decision: 'retry', nextAttempt };
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
    return backoffMs(attempts);
  }

  /** Record a delivery attempt's outcome and decide what happens to the message. */
  recordAttempt(id: string, outcome: AttemptOutcome, now: number): QueueDecision {
    const msg = this.#messages.get(id);
    if (msg === undefined) return 'delivered';
    msg.attempts += 1;
    const { decision, nextAttempt } = decideRetry(msg.attempts, msg.firstQueued, outcome, now, this.#defects);
    if (decision === 'retry') msg.nextAttempt = nextAttempt;
    else this.#messages.delete(id);
    return decision;
  }
}
