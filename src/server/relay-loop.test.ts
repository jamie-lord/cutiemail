/**
 * The relay loop over the persistent queue. The behaviours that matter for not
 * losing mail, each with an injected relay result and a controlled clock:
 *   - a transient failure (greylist / MX down) is retried on the backoff, not dropped
 *   - a permanent (5yz) failure bounces immediately, no retry
 *   - a partial delivery carries only the not-yet-delivered recipients forward
 *   - past the give-up window a still-failing message bounces
 *   - a message left in the queue survives a "restart" (a fresh loop, same db)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { RelayLoop } from './relay-loop.ts';
import { MIN_RETRY_MS, GIVE_UP_MS } from '../store/queue.ts';
import type { RelayResult } from './outbound.ts';

const r = (recipient: string, classification: RelayResult['classification']): RelayResult => ({
  recipient,
  ok: classification === 'success',
  classification,
  detail: classification,
});

test('a transient failure is retried on the backoff, then delivered', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const outcomes: RelayResult['classification'][] = ['transient', 'success'];
  let calls = 0;
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => {
    const c = outcomes[calls++]!;
    return m.recipients.map((rc) => r(rc, c));
  };
  const loop = new RelayLoop(queue, relay);

  const t0 = 1_000_000;
  queue.enqueue('me@x.test', ['friend@y.test'], Buffer.from('msg'), t0);

  await loop.tick(t0);
  assert.equal(queue.size, 1, 'transient failure keeps the message queued');
  assert.equal(queue.due(t0).length, 0, 'and not due again immediately');
  assert.equal(queue.due(t0 + MIN_RETRY_MS).length, 1, 'due again after the minimum retry delay');

  await loop.tick(t0 + MIN_RETRY_MS);
  assert.equal(queue.size, 0, 'delivered on the retry and removed');
  assert.equal(calls, 2);
});

test('a permanent failure bounces immediately, no retry', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'permanent'));
  const loop = new RelayLoop(queue, relay);
  queue.enqueue('me@x.test', ['bad@y.test'], Buffer.from('msg'), 0);
  await loop.tick(0);
  assert.equal(queue.size, 0, 'a 5yz recipient is bounced, not retried');
});

test('a partial delivery carries only the undelivered recipient forward', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> =>
    m.recipients.map((rc) => r(rc, rc === 'ok@y.test' ? 'success' : 'transient'));
  const loop = new RelayLoop(queue, relay);
  queue.enqueue('me@x.test', ['ok@y.test', 'slow@y.test'], Buffer.from('msg'), 0);

  await loop.tick(0);
  const due = queue.due(MIN_RETRY_MS);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0]!.recipients, ['slow@y.test'], 'only the transient recipient is retried, not the delivered one');
});

test('past the give-up window, a still-failing message bounces', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'transient'));
  const loop = new RelayLoop(queue, relay);
  const t0 = 5_000_000;
  queue.enqueue('me@x.test', ['gone@y.test'], Buffer.from('msg'), t0);

  await loop.tick(t0 + GIVE_UP_MS + 1);
  assert.equal(queue.size, 0, 'a message failing past the give-up window is bounced');
});

test('a tick requested while one is in progress is not dropped (no interval-length delay)', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
  let calls = 0;
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => {
    calls += 1;
    if (calls === 1) await firstBlocked; // hold the first entry's relay open
    return m.recipients.map((rc) => r(rc, 'success'));
  };
  const loop = new RelayLoop(queue, relay);

  queue.enqueue('me@x.test', ['a@y.test'], Buffer.from('one'), 1000);
  const tick1 = loop.tick(1000); // starts, blocks inside the first relay
  await new Promise((res) => setTimeout(res, 10));

  // A second message arrives and its immediate tick fires WHILE the first is running.
  queue.enqueue('me@x.test', ['b@y.test'], Buffer.from('two'), 1000);
  const tick2 = loop.tick(1000); // must be remembered, not silently dropped

  await new Promise((res) => setTimeout(res, 10));
  releaseFirst();
  await Promise.all([tick1, tick2]);

  assert.equal(queue.size, 0, 'both messages were delivered — the mid-tick request re-ran, not waited for the interval');
  assert.equal(calls, 2, 'the second message was actually attempted');
});

test('a queued message survives a restart (fresh loop, same database)', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = SqliteQueue.open(db);
  // First loop leaves it queued (transient), then "crashes".
  const failing = new RelayLoop(queue, async (m) => m.recipients.map((rc) => r(rc, 'transient')));
  const t0 = 2_000_000;
  queue.enqueue('me@x.test', ['friend@y.test'], Buffer.from('recover me'), t0);
  await failing.tick(t0);
  assert.equal(queue.size, 1);

  // A fresh loop over the SAME queue delivers it on the next due tick.
  let relayed: Buffer | null = null;
  const recovered = new RelayLoop(SqliteQueue.open(db), async (m) => {
    relayed = m.data;
    return m.recipients.map((rc) => r(rc, 'success'));
  });
  await recovered.tick(t0 + MIN_RETRY_MS);
  assert.equal(queue.size, 0, 'recovered and delivered after restart');
  assert.equal((relayed as Buffer | null)?.toString(), 'recover me', 'the exact queued bytes are relayed');
});
