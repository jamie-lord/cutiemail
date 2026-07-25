/**
 * MTA-STS resolution + caching (RFC 8461 §3.1/§3.3). Injected DNS + fetch so the cache
 * logic is exercised without a network: fetch at most once per id per max_age, refetch on
 * an id rotation or expiry, and keep a still-valid cached policy when a refetch fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StsCache, readPolicyResponse, httpsFetchPolicy, type StsResolverDeps } from './mta-sts-resolve.ts';
import { parseStsPolicy } from '../transport/mta-sts.ts';

const POLICY = 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\n';

/** A controllable deps harness: settable TXT id, policy body, and clock; counts fetches. */
function harness(opts: { id: string | null; body?: string | null }) {
  const state: { id: string | null; body: string | null; t: number; fetches: number; txtLookups: number } = { id: opts.id, body: opts.body ?? POLICY, t: 1_000_000, fetches: 0, txtLookups: 0 };
  const deps: StsResolverDeps = {
    resolveTxt: async (name) => {
      state.txtLookups++;
      if (name === '_mta-sts.example.com' && state.id !== null) return [`v=STSv1; id=${state.id}`];
      return [];
    },
    fetchPolicy: async () => {
      state.fetches++;
      return state.body === null ? null : Buffer.from(state.body, 'latin1');
    },
    now: () => state.t,
  };
  return { state, deps };
}

test('no _mta-sts TXT record → no policy, and no HTTPS fetch is attempted', async () => {
  const { state, deps } = harness({ id: null });
  const cache = new StsCache();
  assert.equal(await cache.resolve('example.com', deps), null);
  assert.equal(state.fetches, 0, 'never fetch a policy for a domain that advertises none');
});

test('a published policy is fetched once and served from cache within max_age', async () => {
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  const p1 = await cache.resolve('example.com', deps);
  assert.equal(p1?.mode, 'enforce');
  assert.deepEqual(p1?.mx, ['mail.example.com']);
  state.t += 3600_000; // +1h, still within the 86400s max_age
  const p2 = await cache.resolve('example.com', deps);
  assert.equal(p2?.mode, 'enforce');
  assert.equal(state.fetches, 1, 'served from cache — fetched only once');
});

test('a rotated id forces a refetch even within the cached lifetime', async () => {
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  await cache.resolve('example.com', deps);
  state.id = 'v2'; // owner rotated the policy
  await cache.resolve('example.com', deps);
  assert.equal(state.fetches, 2, 'a changed id triggers a refetch');
});

test('an expired cache entry is refetched', async () => {
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  await cache.resolve('example.com', deps);
  state.t += 86400_000 + 1; // past max_age
  await cache.resolve('example.com', deps);
  assert.equal(state.fetches, 2, 'expiry triggers a refetch');
});

test('a failed refetch keeps serving a still-valid cached policy (§5.1)', async () => {
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  await cache.resolve('example.com', deps);
  state.id = 'v2'; // rotation forces a refetch...
  state.body = null; // ...but the fetch now fails
  const p = await cache.resolve('example.com', deps);
  assert.equal(p?.mode, 'enforce', 'the previous, still-unexpired policy is retained');
  assert.equal(state.fetches, 2);
});

test('a fetch that returns an invalid policy yields no policy', async () => {
  const { deps } = harness({ id: 'v1', body: 'version: bogus\nmode: whatever\n' });
  const cache = new StsCache();
  assert.equal(await cache.resolve('example.com', deps), null);
});

test('a cached enforce policy SURVIVES a TXT-lookup failure (§5.1 - no downgrade)', async () => {
  // The regression: a thrown TXT lookup used to be treated as id=null → the cached policy was
  // DELETED and null returned, letting an active attacker strip TLS by suppressing the
  // unauthenticated TXT lookup. It must now serve the still-valid cache instead.
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  assert.equal((await cache.resolve('example.com', deps))?.mode, 'enforce');
  const blackout: StsResolverDeps = { ...deps, resolveTxt: async () => { throw new Error('SERVFAIL'); } };
  state.t += 3600_000; // +1h, still within max_age
  assert.equal((await cache.resolve('example.com', blackout))?.mode, 'enforce', 'the unexpired cache is served despite the DNS failure');
  // Past expiry, a still-failing lookup finally yields no policy (nothing left to downgrade FROM).
  state.t += 86400_000;
  assert.equal(await cache.resolve('example.com', blackout), null, 'an expired cache is not served forever');
});

test('multiple v=STSv1 records are ambiguous: no fresh policy, and the cached one is KEPT (§3.1/§5.1)', async () => {
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  assert.equal((await cache.resolve('example.com', deps))?.mode, 'enforce');
  const doubled: StsResolverDeps = { ...deps, resolveTxt: async () => ['v=STSv1; id=v1', 'v=STSv1; id=zzz'] };
  assert.equal((await cache.resolve('example.com', doubled))?.mode, 'enforce', 'an ambiguous TXT answer must not drop the cached policy');
  assert.equal(state.fetches, 1, 'and must not trigger a refetch');
});

test('an ABSENT record does NOT forget a cached policy either (§3.3 MUST, §10.2) - only expiry retires it', async () => {
  // This inverts an earlier assertion that a clean empty lookup was "definitively absent" and so
  // could evict. RFC 8461 §3.1 puts zero records and several records in the SAME "not one" case
  // and attaches its do-not-evict note to both; §3.3 is a normative MUST to apply an unexpired
  // cached policy when no live one can be discovered; §8.3 makes a fetched `mode: none` the
  // retirement path. Evicting here let ONE forged NXDOMAIN — the TXT lookup is unauthenticated —
  // turn enforce into cleartext delivery, which is exactly the attack §10.2 says the cache exists
  // to resist.
  const { state, deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  assert.equal((await cache.resolve('example.com', deps))?.mode, 'enforce');
  const gone: StsResolverDeps = { ...deps, resolveTxt: async () => [] };
  assert.equal((await cache.resolve('example.com', gone))?.mode, 'enforce', 'a forged/absent record must not strip enforcement');
  assert.equal(state.fetches, 1, 'and must not trigger a refetch');
  // The cache is not kept forever: once max_age lapses there is nothing left to serve.
  state.t += 86400_000 * 2;
  assert.equal(await cache.resolve('example.com', gone), null, 'an expired cache is not served indefinitely');
});

test('max_age is clamped to the RFC 8461 §3.2 ceiling, so a policy always ages out', async () => {
  // Without the clamp, `max_age: 1e308` gives expiresAt = Infinity and the entry can never
  // expire. That is only survivable while something else evicts it — and now that an absent
  // record correctly does NOT evict (above), the ceiling is what guarantees a policy captured
  // during a transient takeover eventually lapses. The two fixes are load-bearing together.
  const { state, deps } = harness({ id: 'v1', body: 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 1e308\n' });
  const cache = new StsCache();
  assert.equal(await cache.resolve('example.com', deps), null, '1e308 is not 1*10(DIGIT): not a valid max_age');

  const { state: s2, deps: d2 } = harness({ id: 'v1', body: 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 9999999999\n' });
  const c2 = new StsCache();
  assert.equal((await c2.resolve('example.com', d2))?.mode, 'enforce', '10 digits is grammatical, so it parses');
  const gone: StsResolverDeps = { ...d2, resolveTxt: async () => [] };
  s2.t += 31_557_600 * 1000 + 1000; // just past the one-year ceiling
  assert.equal(await c2.resolve('example.com', gone), null, 'and expires at the ceiling, not 317 years out');
  assert.ok(state.fetches >= 0 && s2.fetches >= 1);
});

test('readPolicyResponse: a non-2xx status yields null; an oversize body is REFUSED, never buffered whole', async () => {
  assert.equal(await readPolicyResponse({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }, 64), null, 'a non-2xx status serves no policy');

  // A declared over-cap content-length is refused without reading a byte.
  assert.equal(
    await readPolicyResponse(
      { ok: true, headers: { get: () => '68719476736' }, arrayBuffer: async () => new ArrayBuffer(0) },
      65_536,
    ),
    null,
    'a declared 64 GiB body is refused up front',
  );

  // A streamed body over the cap is abandoned mid-read, and the reader is cancelled — the whole
  // point of the fix. `arrayBuffer()` is deliberately made to throw: if the implementation ever
  // falls back to buffering the entire response, this test fails loudly rather than passing on a
  // truncated prefix.
  let delivered = 0;
  let cancelled = false;
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  const endless = {
    ok: true,
    headers: { get: (): string | null => null },
    body: {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value: Uint8Array }> => {
          delivered += chunk.length;
          return { done: false, value: chunk };
        },
        cancel: async (): Promise<void> => { cancelled = true; },
      }),
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => { throw new Error('must not buffer the whole body'); },
  } as unknown as Parameters<typeof readPolicyResponse>[0];
  assert.equal(await readPolicyResponse(endless, 65_536), null, 'an endless body yields no policy');
  assert.ok(cancelled, 'and the reader is cancelled rather than left draining');
  assert.ok(delivered <= 65_536 + chunk.length, `at most one chunk past the cap is read (read ${delivered})`);

  // A well-formed under-cap body still parses.
  const policy = 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\n';
  const ab = new ArrayBuffer(policy.length);
  new Uint8Array(ab).set(Buffer.from(policy, 'latin1'));
  const ok = await readPolicyResponse({ ok: true, arrayBuffer: async () => ab }, 65_536);
  assert.equal(ok?.toString('latin1'), policy, 'an under-cap body is returned intact');
  assert.equal(parseStsPolicy(ok!).mode, 'enforce', 'and parses to the real policy');
});

test('httpsFetchPolicy refuses an mta-sts host that resolves to a private/loopback address (SSRF guard)', async () => {
  // The attacker controls the recipient domain's DNS and points mta-sts.<domain> at an internal IP.
  // The fetch must be refused before any connection, exactly like the MX relay path.
  const toPrivate = httpsFetchPolicy(10_000, 65_536, async () => ['10.0.0.5']);
  assert.equal(await toPrivate('evil.example'), null, 'a private-resolving mta-sts host is refused');

  const toMappedLoopback = httpsFetchPolicy(10_000, 65_536, async () => ['::ffff:127.0.0.1']);
  assert.equal(await toMappedLoopback('evil.example'), null, 'an IPv4-mapped loopback target is refused');

  const toMetadata = httpsFetchPolicy(10_000, 65_536, async () => ['169.254.169.254']);
  assert.equal(await toMetadata('evil.example'), null, 'a link-local metadata target is refused');

  const unresolvable = httpsFetchPolicy(10_000, 65_536, async () => []);
  assert.equal(await unresolvable('evil.example'), null, 'an unresolvable host yields no policy');
});
