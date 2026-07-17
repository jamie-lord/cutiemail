/**
 * MTA-STS policy resolution + caching (RFC 8461 §3.1, §3.3) — the network half that the
 * pure parser/matcher (transport/mta-sts.ts) deliberately left out.
 *
 * A domain advertises MTA-STS with a DNS TXT record at `_mta-sts.<domain>` carrying an
 * `id=`; the policy itself is fetched over HTTPS from
 * `https://mta-sts.<domain>/.well-known/mta-sts.txt`. The policy is cached for its
 * `max_age`, keyed by the id — a changed id means the owner rotated the policy, so we
 * refetch even within the cached lifetime. A fetch failure keeps a still-valid cached
 * policy rather than silently dropping enforcement (RFC 8461 §5.1).
 *
 * DNS and HTTPS are injected so the cache logic is testable without a network; the
 * production deps do a real cert-validated, size- and time-bounded GET.
 */

import { parseStsPolicy, type StsPolicy } from '../transport/mta-sts.ts';

export interface StsResolverDeps {
  /** TXT lookup (records joined). [] when absent; may throw on a DNS error. */
  readonly resolveTxt: (name: string) => Promise<readonly string[]>;
  /** GET the well-known policy for a domain, or null if it cannot be fetched. */
  readonly fetchPolicy: (domain: string) => Promise<Buffer | null>;
  readonly now: () => number;
}

interface CacheEntry {
  readonly policy: StsPolicy;
  readonly id: string;
  readonly expiresAt: number;
}

export class StsCache {
  readonly #entries = new Map<string, CacheEntry>();

  /**
   * The current MTA-STS policy for a domain, or null if it publishes none (or the policy
   * can neither be fetched nor served from a live cache). Fetches at most once per id
   * per max_age window.
   */
  async resolve(domain: string, deps: StsResolverDeps): Promise<StsPolicy | null> {
    const d = domain.toLowerCase().replace(/\.+$/, '');
    const now = deps.now();

    // 1. The STS TXT record: presence + the policy id (rotates when the policy changes).
    let id: string | null = null;
    try {
      const txts = await deps.resolveTxt(`_mta-sts.${d}`);
      const rec = txts.find((t) => t.toLowerCase().startsWith('v=stsv1'));
      if (rec !== undefined) {
        const m = /(?:^|;)\s*id\s*=\s*([^;]+)/i.exec(rec);
        id = m ? m[1]!.trim() : null;
      }
    } catch {
      id = null; // a DNS failure is treated as "no policy right now" (opportunistic TLS)
    }
    if (id === null) {
      this.#entries.delete(d); // no policy published — forget any stale one
      return null;
    }

    // 2. Serve a cached policy with the same id that has not expired.
    const cached = this.#entries.get(d);
    if (cached !== undefined && cached.id === id && cached.expiresAt > now) return cached.policy;

    // 3. (Re)fetch and cache. On failure, fall back to a still-valid cached policy.
    let body: Buffer | null;
    try {
      body = await deps.fetchPolicy(d);
    } catch {
      body = null;
    }
    if (body === null) return cached !== undefined && cached.expiresAt > now ? cached.policy : null;

    const policy = parseStsPolicy(body);
    if (!policy.valid || policy.maxAge === null) {
      return cached !== undefined && cached.expiresAt > now ? cached.policy : null;
    }
    this.#entries.set(d, { policy, id, expiresAt: now + policy.maxAge * 1000 });
    return policy;
  }
}

/**
 * Production policy fetch: a cert-validated HTTPS GET of the well-known policy, with a
 * timeout, a size cap, and no redirects (RFC 8461 §3.3 forbids them). Returns null on any
 * failure so a missing/broken policy degrades to opportunistic TLS rather than blocking mail.
 */
export function httpsFetchPolicy(timeoutMs = 10_000, maxBytes = 65_536): (domain: string) => Promise<Buffer | null> {
  return async (domain: string): Promise<Buffer | null> => {
    const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
