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

test('a durable settle fault does not re-send or re-bounce every tick', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  let relayCalls = 0;
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => {
    relayCalls++;
    return m.recipients.map((rc) => r(rc, 'permanent')); // a 5yz failure → would bounce
  };
  const bounces: unknown[] = [];
  // Simulate a disk-full / lock-held-past-busy_timeout fault: the durable settle (remove AND
  // deadLetter) throws AFTER the message went on the wire. reschedule stays working (best-effort).
  const fault = (): never => {
    throw new Error('SQLITE_FULL');
  };
  const q = queue as unknown as { remove: () => void; deadLetter: () => void };
  q.remove = fault;
  q.deadLetter = fault;
  const loop = new RelayLoop(queue, relay, { onBounce: (b) => bounces.push(b) });
  const t0 = 1_000_000;
  queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('msg'), t0);

  await loop.tick(t0);
  assert.equal(relayCalls, 1, 'the message was sent once');
  assert.equal(bounces.length, 0, 'no bounce is emitted when the durable settle failed (bounce follows a committed settle)');
  // The row is deferred into the future, NOT left due — so an immediate re-tick re-sends nothing
  // and re-bounces nothing (the pre-fix code left it due and stormed every tick).
  assert.equal(queue.due(t0).length, 0, 'the row is deferred, not left immediately due');
  await loop.tick(t0);
  assert.equal(relayCalls, 1, 'not re-sent on an immediate re-tick');
  assert.equal(bounces.length, 0, 'and not re-bounced');
});

test('an all-delivered entry whose remove() throws does NOT re-send the delivered recipients', async () => {
  // The regression: when every recipient delivered and remove() threw, `unsettled` was empty and
  // the code rescheduled entry.recipients - the DELIVERED list - re-delivering the whole message
  // every backoff until the DB recovered, contradicting the never-re-sent invariant. It must
  // instead reschedule an EMPTY (tombstone) recipient list: relay to no one, retry the remove.
  const db = new DatabaseSync(':memory:');
  const queue = SqliteQueue.open(db);
  const relayedTo: string[][] = [];
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => {
    relayedTo.push([...m.recipients]);
    return m.recipients.map((rc) => r(rc, 'success')); // every recipient delivers
  };
  // remove() throws (all-delivered path), reschedule works. deadLetter unused here.
  let removeShouldThrow = true;
  const realRemove = queue.remove.bind(queue);
  (queue as unknown as { remove: (id: string) => void }).remove = (id: string): void => {
    if (removeShouldThrow) throw new Error('SQLITE_FULL');
    realRemove(id);
  };
  const loop = new RelayLoop(queue, relay);
  const t0 = 1_000_000;
  queue.enqueue('me@x.test', ['ok@y.test'], Buffer.from('msg'), t0);

  await loop.tick(t0);
  assert.deepEqual(relayedTo, [['ok@y.test']], 'the message was relayed once');
  assert.equal(queue.due(t0).length, 0, 'the row is deferred, not left immediately due');

  // The DB recovers; the deferred tombstone tick relays to NO ONE and cleans the row up.
  removeShouldThrow = false;
  await loop.tick(t0 + 20 * 60_000); // past SETTLE_FAILURE_BACKOFF
  assert.deepEqual(relayedTo, [['ok@y.test'], []], 'the retry relayed an EMPTY recipient list - the delivered recipient was never re-sent');
  assert.equal(queue.size, 0, 'and the row is finally removed');
});

test('a permanent failure notifies the sender via onBounce (RFC 5321 §6.1)', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'permanent'));
  const bounces: Array<{ from: string; failures: readonly { recipient: string; status: string }[] }> = [];
  const loop = new RelayLoop(queue, relay, { onBounce: (b) => bounces.push(b) });
  queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('the message'), 0);
  await loop.tick(0);
  assert.equal(bounces.length, 1, 'the sender is notified');
  assert.equal(bounces[0]!.from, 'sender@ours.test', 'the bounce is addressed to the original sender');
  assert.equal(bounces[0]!.failures[0]!.recipient, 'bad@y.test', 'the failed recipient is reported');
  assert.match(bounces[0]!.failures[0]!.status, /^5\./, 'the status is a permanent 5.x.x');
});

test('a message with a null return-path never bounces (no bounce loops, §6.1)', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'permanent'));
  const bounces: unknown[] = [];
  const loop = new RelayLoop(queue, relay, { onBounce: (b) => bounces.push(b) });
  queue.enqueue('', ['bad@y.test'], Buffer.from('a bounce itself'), 0); // null return-path
  await loop.tick(0);
  assert.equal(bounces.length, 0, 'a null-return-path failure produces no bounce');
});

test('past the give-up window, the still-failing recipients are bounced to the sender', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'transient'));
  const bounces: Array<{ failures: readonly { status: string }[] }> = [];
  const loop = new RelayLoop(queue, relay, { onBounce: (b) => bounces.push(b) });
  const t0 = 9_000_000;
  queue.enqueue('sender@ours.test', ['slow@y.test'], Buffer.from('m'), t0);
  await loop.tick(t0 + GIVE_UP_MS + 1);
  assert.equal(bounces.length, 1, 'give-up produces a bounce');
  assert.equal(bounces[0]!.failures[0]!.status, '5.4.7', 'the status is delivery-time-expired');
});

test('a settle fault on a mixed permanent+transient give-up keeps (does not drop) the permanent recipient', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> =>
    m.recipients.map((rc) => r(rc, rc === 'perm@x.test' ? 'permanent' : 'transient'));
  const bounces: unknown[] = [];
  // The give-up branch's durable op (deadLetter) throws; reschedule works.
  (queue as unknown as { deadLetter: () => void }).deadLetter = () => {
    throw new Error('SQLITE_FULL');
  };
  const loop = new RelayLoop(queue, relay, { onBounce: (b) => bounces.push(b) });
  const t0 = 7_000_000;
  queue.enqueue('sender@ours.test', ['perm@x.test', 'trans@y.test'], Buffer.from('m'), t0);
  await loop.tick(t0 + GIVE_UP_MS + 1); // past give-up → giveup branch → deadLetter throws

  assert.equal(bounces.length, 0, 'no bounce emitted when the durable settle failed');
  const rescheduled = queue.due(Number.MAX_SAFE_INTEGER);
  assert.equal(rescheduled.length, 1, 'the row is deferred, not lost');
  // BOTH unsettled recipients stay on the row — the permanent one is not dropped (dropping it
  // would silently lose its bounce, since the bounce is emitted only after a clean settle).
  assert.deepEqual([...rescheduled[0]!.recipients].sort(), ['perm@x.test', 'trans@y.test']);
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

test('a relay that throws advances the schedule (backoff, then give-up), not a stuck row', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  let calls = 0;
  const relay = async (): Promise<readonly RelayResult[]> => {
    calls++;
    throw new Error('boom'); // relayOutbound is designed not to, but defend against it
  };
  const loop = new RelayLoop(queue, relay);
  const t0 = 2_000_000;
  queue.enqueue('me@x.test', ['friend@y.test'], Buffer.from('msg'), t0);

  await loop.tick(t0);
  // The throw must NOT leave the row due immediately (which would spin every tick); it
  // is rescheduled on the backoff like any transient failure.
  assert.equal(queue.size, 1, 'still queued after the throw');
  assert.equal(queue.due(t0).length, 0, 'not due again immediately — it advanced its schedule');
  assert.equal(queue.due(t0 + MIN_RETRY_MS).length, 1, 'due again only after the backoff');

  // Past the give-up window, a persistently-throwing relay bounces and is removed —
  // it does not retry forever.
  await loop.tick(t0 + GIVE_UP_MS + MIN_RETRY_MS);
  assert.equal(queue.size, 0, 'eventually gives up and removes the row');
  assert.ok(calls >= 2, 'it did keep attempting on the backoff, not spin');
});

test('a corrupt queue row does not halt due(): the rest of the queue still drains', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = SqliteQueue.open(db);
  // A well-formed message...
  queue.enqueue('me@x.test', ['good@y.test'], Buffer.from('ok'), 1000);
  // ...and a poisoned row whose recipients column is not valid JSON (external tampering;
  // we always write it via JSON.stringify). Inserted directly to simulate corruption.
  db.prepare('INSERT INTO outbound_queue (id, from_addr, recipients, data, first_queued, attempts, next_attempt) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run('poison', 'me@x.test', '{not json', Buffer.from('x'), 500, 500);

  // due() must return the good row and silently skip the poison one — not throw.
  const due = queue.due(2000);
  assert.equal(due.length, 1, 'only the parseable row is returned');
  assert.equal(due[0]!.recipients[0], 'good@y.test', 'and it is the good one');
});

test('a deferral is logged — the everyday retry is visible, not silent', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> =>
    m.recipients.map((rc) => ({ recipient: rc, ok: false, classification: 'transient' as const, detail: '451 4.7.1 greylisted, try later' }));
  const lines: string[] = [];
  const loop = new RelayLoop(queue, relay, { log: (l) => lines.push(l) });
  const t0 = 1_000_000;
  const id = queue.enqueue('me@x.test', ['friend@y.test'], Buffer.from('msg'), t0);
  await loop.tick(t0);
  const deferral = lines.find((l) => l.includes('deferred'));
  assert.ok(deferral !== undefined, `a transient reschedule logs a deferral line (got: ${JSON.stringify(lines)})`);
  assert.ok(deferral.includes(id), 'the line names the queue id');
  assert.match(deferral, /greylisted/, 'the line carries the remote reason');
  assert.match(deferral, /next attempt \d{4}-\d{2}-\d{2}T/, 'the line says when the next attempt is due');
});

test('a remote reason with terminal escapes is neutralised before logging', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const relay = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> =>
    m.recipients.map((rc) => ({ recipient: rc, ok: false, classification: 'permanent' as const, detail: '550 \x1b[2Jgo away\r\nfake ok line' }));
  const lines: string[] = [];
  const loop = new RelayLoop(queue, relay, { log: (l) => lines.push(l) });
  queue.enqueue('me@x.test', ['bad@y.test'], Buffer.from('msg'), 0);
  await loop.tick(0);
  const bounced = lines.find((l) => l.includes('bounced'));
  assert.ok(bounced !== undefined, 'the permanent failure is logged');
  assert.ok(!bounced.includes('\x1b') && !bounced.includes('\n'), 'ESC and newline from the remote MX never reach the log line');
});
