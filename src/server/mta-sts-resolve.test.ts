/**
 * MTA-STS resolution + caching (RFC 8461 §3.1/§3.3). Injected DNS + fetch so the cache
 * logic is exercised without a network: fetch at most once per id per max_age, refetch on
 * an id rotation or expiry, and keep a still-valid cached policy when a refetch fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StsCache, type StsResolverDeps } from './mta-sts-resolve.ts';

const POLICY = 'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\n';

/** A controllable deps harness: settable TXT id, policy body, and clock; counts fetches. */
function harness(opts: { id: string | null; body?: string | null }) {
  const state = { id: opts.id, body: opts.body ?? POLICY, t: 1_000_000, fetches: 0, txtLookups: 0 };
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
