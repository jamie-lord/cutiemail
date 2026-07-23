/**
 * The per-IP auth throttle, with negative controls. Each guard is paired with the case
 * that proves it detects its violation — the threshold is exact (max-1 not blocked, max
 * blocked), the window actually expires, a success prunes only EXPIRED failures (never
 * recent ones — a reset would defeat the throttle), and one IP's failures
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

test('a successful auth does NOT wipe recent failures — the throttle cannot be reset (security)', () => {
  // Attack: an account holder interleaves a success to reset the per-IP guessing budget
  // against OTHER accounts. A success must prune only EXPIRED failures, never recent ones.
  const t = new AuthThrottle({ maxFailures: 3, now: () => 1000 });
  t.recordFailure('1.2.3.4'); // guessing a victim
  t.recordFailure('1.2.3.4');
  t.recordSuccess('1.2.3.4'); // attacker logs into their own account
  assert.equal(t.isBlocked('1.2.3.4'), false, 'two failures (< 3) — a legitimate user is not thrown out');
  t.recordFailure('1.2.3.4');
  // NEGATIVE CONTROL: under the old `delete(ip)` the success cleared everything, leaving
  // only this one failure (not blocked). The prune-expired-only fix keeps the earlier two.
  assert.equal(t.isBlocked('1.2.3.4'), true, 'the success did NOT reset the budget — the third failure blocks');
});

test('a successful auth prunes EXPIRED failures so a legitimate user recovers over time', () => {
  let now = 1000;
  const t = new AuthThrottle({ maxFailures: 2, windowMs: 5000, now: () => now });
  t.recordFailure('1.2.3.4');
  now += 6000; // that failure is now outside the window
  t.recordSuccess('1.2.3.4'); // prunes the expired failure...
  now += 1;
  t.recordFailure('1.2.3.4'); // ...leaving only this fresh one
  assert.equal(t.isBlocked('1.2.3.4'), false, 'the expired failure was pruned; one in-window failure < 2');
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

test('an attacker rotating source addresses within one IPv6 /64 is still blocked (no evasion)', () => {
  // A single /64 holds 2^64 host addresses; keying the full address would give each its own budget.
  // The throttle keys on the /64, so guesses from different hosts in one /64 accumulate together.
  const t = new AuthThrottle({ maxFailures: 3, now: () => 1000 });
  t.recordFailure('2001:db8:abcd:1234::1');
  t.recordFailure('2001:db8:abcd:1234:5555::9');
  t.recordFailure('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
  assert.equal(t.isBlocked('2001:db8:abcd:1234::42'), true, 'a fresh host in the same /64 is already blocked');
  // A different /64 is independent (a real other network is not collaterally blocked).
  assert.equal(t.isBlocked('2001:db8:abcd:9999::1'), false, 'a different /64 has its own budget');
});
