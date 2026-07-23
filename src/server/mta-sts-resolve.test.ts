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

test('a definitively-absent record (a clean empty lookup) DOES forget a cached policy', async () => {
  const { deps } = harness({ id: 'v1' });
  const cache = new StsCache();
  assert.equal((await cache.resolve('example.com', deps))?.mode, 'enforce');
  const gone: StsResolverDeps = { ...deps, resolveTxt: async () => [] };
  assert.equal(await cache.resolve('example.com', gone), null, 'a clean "no record" drops enforcement (the domain retired MTA-STS)');
});

test('readPolicyResponse: a non-2xx status yields null; an oversize body is capped to the parseable prefix', async () => {
  assert.equal(await readPolicyResponse({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }, 64), null, 'a non-2xx status serves no policy');
  const policy = 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\n';
  const oversize = Buffer.concat([Buffer.from(policy, 'latin1'), Buffer.alloc(200_000, 0x41)]);
  const ab = new ArrayBuffer(oversize.length);
  new Uint8Array(ab).set(oversize);
  const capped = await readPolicyResponse({ ok: true, arrayBuffer: async () => ab }, 65_536);
  assert.equal(capped?.length, 65_536, 'the body is capped to maxBytes (RFC 8461 §3.2)');
  assert.equal(parseStsPolicy(capped!).mode, 'enforce', 'the capped prefix still parses to the real policy');
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
