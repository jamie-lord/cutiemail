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

import { lookup } from 'node:dns/promises';
import { parseStsPolicy, type StsPolicy } from '../transport/mta-sts.ts';
import { isPrivateOrLoopback } from '../wire/ip.ts';

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
    let stsRecords: readonly string[] = [];
    let txtLookupFailed = false;
    try {
      const txts = await deps.resolveTxt(`_mta-sts.${d}`);
      stsRecords = txts.filter((t) => t.toLowerCase().startsWith('v=stsv1'));
    } catch {
      txtLookupFailed = true; // a transient DNS error - NOT a definitive "no policy"
    }

    const cached = this.#entries.get(d);
    const servedCache = (): StsPolicy | null =>
      cached !== undefined && cached.expiresAt > now ? cached.policy : null;

    // RFC 8461 §5.1: a cached policy must survive a TXT-lookup failure. The TXT lookup is
    // unauthenticated - an active attacker can suppress it (or pollute it with a second record)
    // to strip TLS. So a THROWN lookup (transient DNS error) or an AMBIGUOUS answer (§3.1: the
    // number of v=STSv1 records is not exactly one → "assume no available policy") must NOT drop
    // an unexpired cached policy: it serves the cache and only forgoes enforcement when there is
    // no live cache. ONLY a clean, definitively-absent record (a successful lookup returning zero
    // v=STSv1 records) forgets the policy, exactly like the HTTPS-fetch-failure path below.
    if (txtLookupFailed) return servedCache();
    if (stsRecords.length === 0) {
      this.#entries.delete(d); // no policy published — forget any stale one
      return null;
    }
    if (stsRecords.length > 1) return servedCache(); // §3.1: multiple records → ambiguous, keep cache

    const m = /(?:^|;)\s*id\s*=\s*([^;]+)/i.exec(stsRecords[0]!);
    const id = m ? m[1]!.trim() : null;
    if (id === null) return servedCache(); // a malformed record (no id) - ambiguous, keep cache

    // 2. Serve a cached policy with the same id that has not expired.
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

/** Resolve a host to all of its A/AAAA addresses (production default for the SSRF vet below). */
async function resolveAllAddresses(host: string): Promise<readonly string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

/**
 * Production policy fetch: a cert-validated HTTPS GET of the well-known policy, with a
 * timeout, a size cap, and no redirects (RFC 8461 §3.3 forbids them). Returns null on any
 * failure so a missing/broken policy degrades to opportunistic TLS rather than blocking mail.
 *
 * `mta-sts.<domain>` is attacker-influenced (the domain is a recipient domain), so — like the MX
 * relay path — the target is resolved and REFUSED if any address is private/loopback, closing the
 * SSRF where an attacker points `mta-sts.<domain>` at an internal host. The resolver is injectable
 * for tests. (fetch re-resolves by name for cert validation; the vet closes the ordinary internal
 * -reach, and the fetch stays cert-validated and blind, so the residual rebinding window is inert.)
 */
export function httpsFetchPolicy(
  timeoutMs = 10_000,
  maxBytes = 65_536,
  resolveHost: (host: string) => Promise<readonly string[]> = resolveAllAddresses,
): (domain: string) => Promise<Buffer | null> {
  return async (domain: string): Promise<Buffer | null> => {
    const host = `mta-sts.${domain}`;
    let addrs: readonly string[];
    try {
      addrs = await resolveHost(host);
    } catch {
      return null; // cannot resolve → no policy (transient, opportunistic TLS)
    }
    if (addrs.length === 0 || addrs.some(isPrivateOrLoopback)) return null; // SSRF guard: refuse internal targets
    const url = `https://${host}/.well-known/mta-sts.txt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
      return await readPolicyResponse(res, maxBytes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The response half of the policy fetch, split out so it is unit-testable without a live TLS
 * endpoint: a non-2xx status yields null (no policy served), and an over-large body is capped to
 * `maxBytes` (RFC 8461 §3.2 bounds the policy size) and the prefix returned for the parser to
 * pin-or-reject. The transport concerns the wrapper keeps - TLS validation, the abort timeout,
 * and `redirect: 'error'` (§3.3 forbids redirects) - are fetch-level and exercised in production.
 */
export async function readPolicyResponse(
  res: { readonly ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> },
  maxBytes: number,
): Promise<Buffer | null> {
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
}
