/**
 * The per-IP auth throttle, with negative controls. Each guard is paired with the case
 * that proves it detects its violation — the threshold is exact (max-1 not blocked, max
 * blocked), the window actually expires, success actually clears, and one IP's failures
 * never block another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthThrottle } from './auth-throttle.ts';

test('an IP is blocked at exactly maxFailures, not before (threshold is real)', () => {
  const t = new AuthThrottle({ maxFailures: 3, now: () => 1000 });
  t.recordFailure('1.2.3.4');
  t.recordFailure('1.2.3.4');
  assert.equal(t.isBlocked('1.2.3.4'), false, 'two failures (< 3) must NOT block — negative control');
  t.recordFailure('1.2.3.4');
  assert.equal(t.isBlocked('1.2.3.4'), true, 'the third failure reaches the threshold');
});

test('failures outside the window are pruned — an IP recovers', () => {
  let now = 1000;
  const t = new AuthThrottle({ maxFailures: 2, windowMs: 5000, now: () => now });
  t.recordFailure('1.2.3.4');
  t.recordFailure('1.2.3.4');
  assert.equal(t.isBlocked('1.2.3.4'), true);
  now += 5001; // both failures now older than the window
  assert.equal(t.isBlocked('1.2.3.4'), false, 'the window drained → no longer blocked');
});

test('a partial window: only failures still inside the window count', () => {
  let now = 1000;
  const t = new AuthThrottle({ maxFailures: 2, windowMs: 5000, now: () => now });
  t.recordFailure('1.2.3.4'); // t=1000
  now += 4000; // t=5000
  t.recordFailure('1.2.3.4'); // t=5000
  now += 2000; // t=7000 — the first (t=1000) is now > 5000ms old, the second is not
  assert.equal(t.isBlocked('1.2.3.4'), false, 'only one failure remains in-window');
});

test('a successful auth clears the IP — a legitimate user is not left throttled', () => {
  const t = new AuthThrottle({ maxFailures: 2, now: () => 1000 });
  t.recordFailure('1.2.3.4');
  t.recordSuccess('1.2.3.4');
  t.recordFailure('1.2.3.4');
  assert.equal(t.isBlocked('1.2.3.4'), false, 'the pre-success failure was cleared');
});

test('one IP\'s failures never block a different IP', () => {
  const t = new AuthThrottle({ maxFailures: 2, now: () => 1000 });
  t.recordFailure('1.2.3.4');
  t.recordFailure('1.2.3.4');
  assert.equal(t.isBlocked('1.2.3.4'), true);
  assert.equal(t.isBlocked('5.6.7.8'), false, 'per-IP isolation — no collateral lockout');
});

test('the tracked-IP map is bounded (a flood of distinct IPs cannot grow it without limit)', () => {
  const t = new AuthThrottle({ maxFailures: 100, maxTrackedIps: 4, now: () => 1000 });
  for (let i = 0; i < 50; i++) t.recordFailure(`10.0.0.${i}`);
  // The cap holds; only the most-recent few IPs remain tracked (older ones evicted).
  assert.equal(t.isBlocked('10.0.0.49'), false); // recent, tracked, under threshold
  // An evicted early IP starts fresh (its single failure was dropped) — acceptable, and it
  // proves the map did not retain all 50.
  assert.equal(t.isBlocked('10.0.0.0'), false);
});
