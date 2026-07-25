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

    // RFC 8461 §3.3: "if no 'live' policy can be discovered via DNS or fetched via HTTPS, but a
    // valid (non-expired) policy exists in the sender's cache, the sender MUST apply that cached
    // policy." The TXT lookup is unauthenticated (node:dns does no DNSSEC validation), and §10.2
    // names the attacker who suppresses it precisely so the cache can resist him.
    //
    // §3.1 puts zero records and several records in ONE case — "if the number of resulting
    // records is not one ... senders MUST assume the recipient domain does not have an available
    // MTA-STS Policy" — and attaches the do-not-evict note to that whole case. So an absent
    // record is not a signal to forget: a policy is retired only by a fetched, valid policy
    // carrying `mode: none` (§8.3). Treating a clean empty answer as definitive let one forged
    // NXDOMAIN evict an enforce policy and deliver the message in the clear.
    if (txtLookupFailed) return servedCache();
    if (stsRecords.length !== 1) return servedCache();

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
 * endpoint: a non-2xx status yields null (no policy served), and a body over `maxBytes` is
 * refused. The transport concerns the wrapper keeps - TLS validation, the abort timeout, and
 * `redirect: 'error'` (§3.3 forbids redirects) - are fetch-level and exercised in production.
 *
 * The body is read INCREMENTALLY and abandoned the moment it exceeds the cap. `arrayBuffer()`
 * would buffer the whole response first and only then apply the limit, so the "cap" bounded the
 * return value and nothing else: a chunked endless body reached multiple gigabytes of resident
 * memory in seconds, per recipient and again on every queue retry (an invalid policy is not
 * cached). Neither of the two apparent bounds held — a declared `content-length` was never
 * consulted, and the AbortSignal on the fetch does not reliably terminate a body read already in
 * progress, so the reader is cancelled here rather than trusted to unwind from outside.
 *
 * Over-cap is a refusal (null), not a truncation. RFC 8461 §3.3 only permits a size limit ("a
 * suggested maximum policy size is 64 kilobytes"); it does not license honouring the prefix of a
 * body whose remainder we never saw, and a policy is a security control — a partial one should
 * fail closed to opportunistic TLS, not be pinned.
 */
export async function readPolicyResponse(
  res: {
    readonly ok: boolean;
    readonly headers?: { get: (name: string) => string | null };
    readonly body?: ReadableStream<Uint8Array> | null;
    arrayBuffer: () => Promise<ArrayBuffer>;
  },
  maxBytes: number,
  deadlineMs = 30_000,
): Promise<Buffer | null> {
  if (!res.ok) return null;

  // Cheapest rejection first: an honest server that declares an over-cap body saves us the read.
  const declared = Number(res.headers?.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = res.body?.getReader?.();
  if (reader === undefined || reader === null) {
    // No stream (an injected test double, or a body-less response): fall back to the buffered
    // read, still refusing anything over the cap.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }

  const timer = setTimeout(() => void reader.cancel().catch(() => {}), deadlineMs);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
