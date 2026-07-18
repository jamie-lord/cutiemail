/**
 * Brute-force auth throttle — a per-source-IP sliding window of failed authentication
 * attempts, shared across the IMAP and submission auth paths.
 *
 * SCRAM/PLAIN-over-TLS protects the password on the wire but not against online GUESSING:
 * an internet-exposed AUTH endpoint with no rate limit lets an attacker try passwords as
 * fast as it can open connections. This caps that: after `maxFailures` failures from an IP
 * within `windowMs`, further attempts from that IP are refused WITHOUT checking the
 * password (so there is no timing oracle and no CPU spent on SCRAM) until the window drains.
 *
 * Deliberately per-IP, NOT per-account: a per-account lockout would let an attacker lock a
 * victim out of their own mailbox by failing their account on purpose. Keyed on the source
 * address, the attacker only ever locks out themselves. In-memory by design — a restart
 * clearing the counters is acceptable, and the map is capped so a flood of distinct source
 * IPs cannot exhaust memory.
 */

export interface AuthThrottleOptions {
  /** Failures within the window before an IP is blocked (default 10). */
  readonly maxFailures?: number;
  /** The sliding-window length in ms (default 15 minutes). */
  readonly windowMs?: number;
  /** Cap on distinct IPs tracked, oldest evicted past it (default 10 000). */
  readonly maxTrackedIps?: number;
  /** Clock injection for tests (default Date.now). */
  readonly now?: () => number;
}

export class AuthThrottle {
  readonly #max: number;
  readonly #window: number;
  readonly #cap: number;
  readonly #now: () => number;
  /** ip -> ascending failure timestamps within the window. */
  readonly #fails = new Map<string, number[]>();

  constructor(options: AuthThrottleOptions = {}) {
    this.#max = options.maxFailures ?? 10;
    this.#window = options.windowMs ?? 15 * 60_000;
    this.#cap = options.maxTrackedIps ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /** The failures for `ip` still inside the window (prunes expired ones in place). */
  #recent(ip: string): number[] {
    const all = this.#fails.get(ip);
    if (all === undefined) return [];
    const cutoff = this.#now() - this.#window;
    const kept = all.filter((t) => t > cutoff);
    if (kept.length === 0) this.#fails.delete(ip);
    else if (kept.length !== all.length) this.#fails.set(ip, kept);
    return kept;
  }

  /** True when `ip` has reached the failure threshold and should be refused. */
  isBlocked(ip: string): boolean {
    return this.#recent(ip).length >= this.#max;
  }

  /** Record a failed authentication attempt from `ip`. */
  recordFailure(ip: string): void {
    const kept = this.#recent(ip);
    if (!this.#fails.has(ip) && this.#fails.size >= this.#cap) {
      // Evict the oldest-tracked IP (Map preserves insertion order) to stay bounded.
      const oldest = this.#fails.keys().next().value;
      if (oldest !== undefined) this.#fails.delete(oldest);
    }
    kept.push(this.#now());
    this.#fails.set(ip, kept);
  }

  /**
   * A successful auth prunes only the IP's EXPIRED failures — it must NOT clear recent
   * ones. Deleting the whole record let an attacker holding one valid credential reset the
   * guessing budget against every OTHER account from the same IP: guess N times, log in to
   * their own account to wipe the failures, repeat, unlimited. A legitimate user is still
   * never left throttled: to reach this call they were under the threshold (a blocked IP is
   * refused before the password is checked), and their old failures age out on the window.
   */
  recordSuccess(ip: string): void {
    this.#recent(ip); // prunes expired failures in place; keeps recent ones
  }
}
