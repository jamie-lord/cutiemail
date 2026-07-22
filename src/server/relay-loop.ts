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
import { sanitizeForTerminalLine } from '../ops/terminal.ts';

export interface RelayFn {
  (msg: { from: string; recipients: readonly string[]; data: Buffer }): Promise<readonly RelayResult[]>;
}

/** A recipient the relay has permanently given up on. */
export interface BouncedRecipient {
  readonly recipient: string;
  /** RFC 3463 status (5.x.x permanent, e.g. 5.0.0 rejected / 5.4.7 timed out). */
  readonly status: string;
  readonly detail: string;
}

export interface RelayLoopOptions {
  readonly log?: (line: string) => void;
  readonly defects?: QueueDefects;
  /**
   * Called when a message is permanently undeliverable to some recipients, so the
   * sender can be sent a non-delivery report (RFC 5321 §6.1). Never called when the
   * sender is empty — a null return-path message must not itself bounce.
   */
  readonly onBounce?: (info: { from: string; data: Buffer; failures: readonly BouncedRecipient[] }) => void;
}

/** How far to defer a row whose durable settle threw, so it is not re-sent every tick. */
const SETTLE_FAILURE_BACKOFF_MS = 15 * 60_000;

/** A compact one-line failure summary retained with a dead letter. */
function deadLetterReason(failures: readonly BouncedRecipient[]): string {
  return failures.map((f) => `<${f.recipient}> ${f.status}: ${f.detail}`).join('; ');
}

export class RelayLoop {
  readonly #queue: SqliteQueue;
  readonly #relay: RelayFn;
  readonly #log: (line: string) => void;
  readonly #defects: QueueDefects;
  readonly #onBounce: RelayLoopOptions['onBounce'];
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  /** Set by stop(): the in-flight tick bails at the next entry boundary and no new work starts. */
  #stopped = false;
  /** The currently-running tick, so stop() can await it before the DB is closed. */
  #running: Promise<void> = Promise.resolve();
  /** A tick requested while one was running — its `now`, so the re-run isn't lost. */
  #pending: number | null = null;

  constructor(queue: SqliteQueue, relay: RelayFn, options: RelayLoopOptions = {}) {
    this.#queue = queue;
    this.#relay = relay;
    this.#log = options.log ?? ((): void => {});
    this.#defects = options.defects ?? {};
    this.#onBounce = options.onBounce;
  }

  /** Emit a bounce for permanently-failed recipients — unless the sender is null (§6.1). */
  #bounce(from: string, data: Buffer, failures: readonly BouncedRecipient[]): void {
    if (failures.length === 0) return;
    // A null return-path (<>) message must never generate a bounce — that is how
    // bounce loops start. Such failures are dropped (already logged).
    if (from === '' || this.#onBounce === undefined) return;
    this.#onBounce({ from, data, failures });
  }

  /**
   * Process every entry due at `now`. Ticks never overlap — but a tick requested
   * while one is running is NOT dropped: it is remembered and run as soon as the
   * current one finishes. (Dropping it meant a message enqueued mid-tick waited
   * for the next timer interval — up to a minute — before its first attempt.)
   */
  async tick(now: number): Promise<void> {
    this.#pending = now;
    if (this.#ticking) return this.#running;
    this.#ticking = true;
    this.#running = (async () => {
      try {
        while (this.#pending !== null) {
          if (this.#stopped) return; // stopped (shutdown) before starting a batch — do not touch the DB
          const at = this.#pending;
          this.#pending = null;
          for (const entry of this.#queue.due(at)) {
            // Bail at the entry boundary if stop() was called mid-drain: leave the remaining rows
            // durably queued (recovered on next start) rather than race the DB being closed under us.
            if (this.#stopped) return;
            await this.#processEntry(entry, at);
          }
        }
      } finally {
        this.#ticking = false;
      }
    })();
    return this.#running;
  }

  async #processEntry(entry: QueueEntry, now: number): Promise<void> {
    let results: readonly RelayResult[];
    try {
      results = await this.#relay({ from: entry.from, recipients: entry.recipients, data: entry.data });
    } catch (e) {
      this.#log(`queue ${entry.id}: relay error, ${String(e)}`);
      // relayOutbound is designed not to throw, but if it ever does (bug, OOM), treat it
      // as transient for every recipient so the entry ADVANCES its schedule — backoff and
      // eventually give-up + bounce — instead of retrying every tick forever (a stuck row).
      results = entry.recipients.map((recipient) => ({ recipient, ok: false, classification: 'transient' as const, detail: String(e) }));
    }

    const retryLater: string[] = [];
    const permanentFailures: BouncedRecipient[] = [];
    // `detail` carries the remote MX's response bytes — sanitised before it reaches the
    // operator's log/terminal, like every other remote-derived string we print.
    for (const r of results) {
      if (r.classification === 'transient') retryLater.push(r.recipient);
      else {
        this.#log(sanitizeForTerminalLine(`queue ${entry.id} ${r.recipient}: ${r.ok ? 'sent' : 'bounced'}, ${r.detail}`));
        if (!r.ok) permanentFailures.push({ recipient: r.recipient, status: '5.0.0', detail: r.detail });
      }
    }

    const attempts = entry.attempts + 1;
    // The message has ALREADY gone on the wire. Emit bounces only AFTER the durable state
    // transition (remove / deadLetter / reschedule) commits — never before. If we bounced first
    // and the settle then threw (disk-full, a write lock held past busy_timeout, a crash), the
    // row would stay due and be re-processed next tick — RE-SENDING the message and RE-EMITTING
    // backscatter to the (forgeable) sender every ~60 s until the fault cleared.
    const toBounce: BouncedRecipient[] = [...permanentFailures]; // 5yz rejections are final
    try {
      if (retryLater.length === 0) {
        // Every recipient settled: retain permanent failures in dead-letter (operator can
        // inspect / re-queue) or, if all delivered, just drop the live row.
        this.#settle(entry, permanentFailures, now);
      } else {
        const { decision, nextAttempt } = decideRetry(attempts, entry.firstQueued, 'transient', now, this.#defects);
        if (decision === 'retry') {
          this.#queue.reschedule(entry.id, retryLater, attempts, nextAttempt);
          // The everyday operator question — "why hasn't it gone yet, and when is the
          // next try" — was previously answered by NOTHING: deferrals were rescheduled
          // silently and only the final sent/bounced/gave-up outcomes logged.
          const why = results.find((r) => r.classification === 'transient')?.detail ?? 'transient failure';
          this.#log(sanitizeForTerminalLine(`queue ${entry.id}: deferred for ${retryLater.length} recipient(s) (attempt ${attempts}), ${why}; next attempt ${new Date(nextAttempt).toISOString()}`));
        } else {
          const gaveUp: BouncedRecipient[] = retryLater.map((recipient) => ({ recipient, status: '5.4.7', detail: `delivery time expired after ${attempts} attempts` }));
          for (const g of gaveUp) this.#log(`queue ${entry.id} ${g.recipient}: bounced (gave up after ${attempts} attempts)`);
          toBounce.push(...gaveUp);
          // The transactional move guarantees a crash here can't remove the row without leaving
          // a dead-letter trace.
          this.#queue.deadLetter({ ...entry, attempts }, { failedRecipients: retryLater, lastError: deadLetterReason(gaveUp), now });
        }
      }
    } catch (e) {
      // The durable settle failed. Do NOT bounce (it would repeat every tick) and do NOT leave
      // the row due (it would re-send every tick): best-effort defer it. If even this write
      // fails the queue store is unwritable and the row stays due until it recovers.
      this.#log(`queue ${entry.id}: settle failed, ${String(e)}; deferring to avoid re-send/re-bounce`);
      try {
        // Defer everything NOT durably settled: the transient (retryLater) recipients AND the
        // permanent-failure recipients whose bounce has not committed (the bounce is emitted only
        // after a clean settle, so a permanent recipient must stay on the row to be re-relayed and
        // bounced on a later tick - dropping it silently loses its bounce). Delivered recipients
        // are ALWAYS excluded - never re-sent. When everything was delivered (unsettled empty) we
        // reschedule an EMPTY recipient list: a tombstone that keeps the row for the operator and
        // for the next remove() attempt, but relays to NO ONE. (Rescheduling entry.recipients here
        // - the delivered list - re-delivered the whole message every backoff until the DB
        // recovered, contradicting the never-re-sent invariant two lines above.)
        const unsettled = [...retryLater, ...permanentFailures.map((f) => f.recipient)];
        this.#queue.reschedule(entry.id, unsettled, attempts, now + SETTLE_FAILURE_BACKOFF_MS);
      } catch {
        /* the queue store is unwritable; the row remains due until it recovers */
      }
      return;
    }
    // The durable transition committed — a re-tick can no longer re-process this entry, so each
    // bounce is emitted exactly once.
    this.#bounce(entry.from, entry.data, toBounce);
  }

  /** Finalise a fully-settled entry: dead-letter permanent failures, else just remove. */
  #settle(entry: QueueEntry, permanentFailures: readonly BouncedRecipient[], now: number): void {
    if (permanentFailures.length === 0) {
      this.#queue.remove(entry.id);
      return;
    }
    this.#queue.deadLetter(
      { ...entry, attempts: entry.attempts + 1 },
      { failedRecipients: permanentFailures.map((f) => f.recipient), lastError: deadLetterReason(permanentFailures), now },
    );
  }

  /** Start ticking on an interval. `clock` defaults to the real clock. */
  start(intervalMs: number, clock: () => number = () => Date.now()): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.tick(clock()), intervalMs);
    this.#timer.unref?.();
  }

  /**
   * Stop ticking and AWAIT any in-flight tick, so a caller can then close the queue's database
   * without a running tick racing it to a "database is not open" crash: a tick draining a
   * backed-up queue could outlive close(), which had cleared the timer but not waited for the
   * tick. A tick mid-drain bails at the next entry boundary (≤ one message), leaving the
   * rest durably queued. Idempotent and safe to await.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#running.catch(() => {});
  }
}
