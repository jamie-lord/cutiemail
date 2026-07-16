/**
 * The outbound-queue retry corpus (RFC 5321 §4.5.4.1), with negative controls. A
 * reference-model test of client-binding requirements the receiver suite cannot
 * observe (they are `not-testable` in the SMTP register for that reason) — cited
 * read-only here for traceability. Time is injected, so the schedule is
 * deterministic. Cites compile-checked RequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryQueue, MIN_RETRY_MS, GIVE_UP_MS } from './queue.ts';
import { requirement } from '../register/rfc5321.ts';
import type { RequirementId } from '../register/rfc5321.ts';

const cites = (id: RequirementId): void => assert.ok(requirement(id).id === id);
const T0 = 1_000_000_000_000; // an injected base time (epoch ms)

test('sanity: a successful attempt removes the message from the queue', () => {
  const q = new DeliveryQueue();
  q.enqueue('m1', T0);
  assert.equal(q.size, 1);
  assert.equal(q.recordAttempt('m1', 'success', T0), 'delivered');
  assert.equal(q.size, 0);
});

test('R-5321-4.5.4.1-a: a message that cannot be delivered is queued and retried', () => {
  cites('R-5321-4.5.4.1-a');
  const q = new DeliveryQueue();
  q.enqueue('m1', T0);
  assert.equal(q.recordAttempt('m1', 'transient', T0), 'retry', 'a transient failure keeps it queued for retry');
  assert.ok(q.has('m1'), 'the message remains queued');
  // A permanent (5yz) failure bounces instead of retrying.
  q.enqueue('m2', T0);
  assert.equal(q.recordAttempt('m2', 'permanent', T0), 'bounced', 'a 5yz bounces, not retries');
  assert.ok(!q.has('m2'));
});

test('R-5321-4.5.4.1-b: retries are delayed after a failure (retryWithoutDelay caught)', () => {
  cites('R-5321-4.5.4.1-b');
  const q = new DeliveryQueue();
  q.enqueue('m1', T0);
  q.recordAttempt('m1', 'transient', T0);
  const next = q.peek('m1')!.nextAttempt;
  assert.ok(next >= T0 + MIN_RETRY_MS, 'the next attempt is delayed by at least the minimum interval');
  assert.deepEqual(q.due(T0), [], 'the message is not immediately due again');

  // Negative control: no delay makes it due at once.
  const defect = new DeliveryQueue({ retryWithoutDelay: true });
  defect.enqueue('m1', T0);
  defect.recordAttempt('m1', 'transient', T0);
  assert.equal(defect.peek('m1')!.nextAttempt, T0, 'retryWithoutDelay must be detectable');
});

test('R-5321-4.5.4.1-d: a message past the give-up window bounces (neverGiveUp caught)', () => {
  cites('R-5321-4.5.4.1-d');
  const q = new DeliveryQueue();
  q.enqueue('m1', T0);
  // A transient failure well past the give-up window bounces rather than requeuing.
  const late = T0 + GIVE_UP_MS + 1;
  assert.equal(q.recordAttempt('m1', 'transient', late), 'bounced', 'past give-up, it bounces');
  assert.ok(!q.has('m1'));

  // Negative control: never giving up keeps retrying forever.
  const defect = new DeliveryQueue({ neverGiveUp: true });
  defect.enqueue('m1', T0);
  assert.equal(defect.recordAttempt('m1', 'transient', late), 'retry', 'neverGiveUp must be detectable');
});
