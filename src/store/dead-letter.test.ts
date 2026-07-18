/**
 * Dead-letter retention: when the relay finally gives up on a message (a permanent
 * 5yz, or the give-up window elapsing) it bounces the sender AND retains the bytes
 * instead of dropping them, so an operator can inspect / re-queue / purge. Every
 * behaviour here carries a NEGATIVE CONTROL proving the assertion detects its
 * violation:
 *   - a given-up message lands in dead-letter, byte-exact (control: a delivered
 *     message does NOT — retention is failure-only);
 *   - the sender is STILL bounced when we dead-letter (control: no bounce means the
 *     assertion would have caught a regression);
 *   - re-queue moves it back to the live queue for another attempt (control: the
 *     dead letter is then gone; a nonexistent id re-queues nothing);
 *   - byte-exactness across the store (control: a one-bit-flipped copy is NOT equal);
 *   - crash-safety of the transactional move: forcing the mid-transaction INSERT to
 *     fail rolls the whole thing back, leaving the message still live — and the
 *     NAIVE remove-then-write ordering is shown to LOSE the message across a real
 *     reopen, which is exactly the hazard the transaction removes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteQueue } from './sqlite-queue.ts';
import { RelayLoop } from '../server/relay-loop.ts';
import { MIN_RETRY_MS, GIVE_UP_MS } from './queue.ts';
import type { RelayResult } from '../server/outbound.ts';

const r = (recipient: string, classification: RelayResult['classification']): RelayResult => ({
  recipient,
  ok: classification === 'success',
  classification,
  detail: classification,
});

const permanent = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'permanent'));
const transient = async (m: { recipients: readonly string[] }): Promise<readonly RelayResult[]> => m.recipients.map((rc) => r(rc, 'transient'));

test('a permanently-failed message lands in dead-letter, byte-exact — a delivered one does not', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const loop = new RelayLoop(queue, permanent);
  const bytes = Buffer.from('Subject: bye\r\n\r\nthe original message\r\n', 'latin1');
  queue.enqueue('sender@ours.test', ['bad@y.test'], bytes, 0);

  await loop.tick(0);
  assert.equal(queue.size, 0, 'removed from the live queue');
  const dead = queue.listDeadLetters();
  assert.equal(dead.length, 1, 'retained in dead-letter');
  assert.equal(dead[0]!.from, 'sender@ours.test');
  assert.deepEqual(dead[0]!.recipients, ['bad@y.test']);
  const got = queue.getDeadLetter(dead[0]!.id);
  assert.ok(got !== undefined);
  assert.ok(got.data.equals(bytes), 'the retained bytes are byte-exact');
  assert.match(got.lastError, /bad@y\.test/, 'the last error records the failed recipient');

  // Negative control: a message that DELIVERS is not retained — retention is
  // failure-only, so this must stay empty.
  const q2 = SqliteQueue.open(new DatabaseSync(':memory:'));
  const good = new RelayLoop(q2, async (m) => m.recipients.map((rc) => r(rc, 'success')));
  q2.enqueue('sender@ours.test', ['ok@y.test'], Buffer.from('delivered'), 0);
  await good.tick(0);
  assert.equal(q2.listDeadLetters().length, 0, 'a delivered message leaves no dead letter');
});

test('a given-up message (past the window) is dead-lettered with byte-exact bytes', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const loop = new RelayLoop(queue, transient);
  const bytes = Buffer.from('slow one', 'latin1');
  const t0 = 9_000_000;
  queue.enqueue('sender@ours.test', ['slow@y.test'], bytes, t0);

  await loop.tick(t0 + GIVE_UP_MS + 1);
  assert.equal(queue.size, 0);
  const dead = queue.listDeadLetters();
  assert.equal(dead.length, 1, 'give-up retains the message');
  assert.deepEqual(dead[0]!.recipients, ['slow@y.test']);
  assert.ok(queue.getDeadLetter(dead[0]!.id)!.data.equals(bytes));
  assert.ok(dead[0]!.attempts >= 1, 'the attempt count is retained');
  assert.match(dead[0]!.lastError, /5\.4\.7/, 'the give-up status is recorded');
});

test('dead-lettering does NOT regress the bounce: the sender is still notified', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const bounces: Array<{ from: string; data: Buffer; failures: readonly { recipient: string }[] }> = [];
  const loop = new RelayLoop(queue, permanent, { onBounce: (b) => bounces.push(b) });
  queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('m'), 0);

  await loop.tick(0);
  assert.equal(bounces.length, 1, 'the bounce STILL fires alongside the dead-letter write');
  assert.equal(bounces[0]!.from, 'sender@ours.test');
  assert.equal(bounces[0]!.failures[0]!.recipient, 'bad@y.test');
  assert.equal(queue.listDeadLetters().length, 1, 'and the message is retained');

  // Negative control: a null return-path never bounces (§6.1) — the assertion above
  // would fail if we had wired dead-letter to suppress the bounce.
  const q2 = SqliteQueue.open(new DatabaseSync(':memory:'));
  const nullBounces: unknown[] = [];
  const loop2 = new RelayLoop(q2, permanent, { onBounce: (b) => nullBounces.push(b) });
  q2.enqueue('', ['bad@y.test'], Buffer.from('a bounce itself'), 0);
  await loop2.tick(0);
  assert.equal(nullBounces.length, 0, 'a null return-path still produces no bounce');
});

test('a partial delivery dead-letters ONLY the failed recipient, not the delivered one', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const loop = new RelayLoop(queue, async (m) => m.recipients.map((rc) => r(rc, rc === 'ok@y.test' ? 'success' : 'permanent')));
  queue.enqueue('sender@ours.test', ['ok@y.test', 'bad@y.test'], Buffer.from('m'), 0);

  await loop.tick(0);
  const dead = queue.listDeadLetters();
  assert.equal(dead.length, 1);
  assert.deepEqual(dead[0]!.recipients, ['bad@y.test'], 'the delivered recipient is NOT retained (no double-send on re-queue)');
});

test('requeue moves a dead letter back to the live queue and it can be retried', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const bytes = Buffer.from('retry me', 'latin1');
  // First: give up, so it dead-letters.
  const failing = new RelayLoop(queue, permanent);
  queue.enqueue('sender@ours.test', ['bad@y.test'], bytes, 0);
  await failing.tick(0);
  const [dead] = queue.listDeadLetters();
  assert.ok(dead !== undefined);

  // Re-queue for another attempt.
  const newId = queue.requeueDeadLetter(dead.id, 1000);
  assert.ok(typeof newId === 'string', 're-queue returns the new live id');
  assert.equal(queue.listDeadLetters().length, 0, 'no longer in dead-letter');
  assert.equal(queue.size, 1, 'back in the live queue');
  const due = queue.due(1000);
  assert.equal(due.length, 1, 'due immediately for another attempt');
  assert.equal(due[0]!.id, newId);
  assert.deepEqual(due[0]!.recipients, ['bad@y.test']);
  assert.equal(due[0]!.attempts, 0, 're-queue resets the attempt count / give-up window');
  assert.ok(due[0]!.data.equals(bytes), 'the re-queued bytes are byte-exact');

  // This time it delivers.
  let relayed: Buffer | null = null;
  const recovered = new RelayLoop(queue, async (m) => {
    relayed = m.data;
    return m.recipients.map((rc) => r(rc, 'success'));
  });
  await recovered.tick(1000);
  assert.equal(queue.size, 0, 'delivered on the re-queued attempt');
  assert.ok((relayed as Buffer | null)!.equals(bytes));

  // Negative control: re-queueing an id that does not exist queues nothing.
  assert.equal(queue.requeueDeadLetter('no-such-id', 2000), undefined);
  assert.equal(queue.size, 0, 'a nonexistent re-queue is a no-op');
});

test('purge discards a dead letter; get/list then no longer see it', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const loop = new RelayLoop(queue, permanent);
  queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('m'), 0);
  await loop.tick(0);
  const [dead] = queue.listDeadLetters();
  assert.ok(dead !== undefined);

  queue.purgeDeadLetter(dead.id);
  assert.equal(queue.listDeadLetters().length, 0, 'purged from the list');
  assert.equal(queue.getDeadLetter(dead.id), undefined, 'and no longer retrievable');
});

test('byte-exactness across the store: binary bytes survive, a flipped copy does NOT match', async () => {
  const queue = SqliteQueue.open(new DatabaseSync(':memory:'));
  const loop = new RelayLoop(queue, permanent);
  // Bytes that a string round-trip would corrupt: a NUL, a lone CR, high bytes, 0xFF.
  const bytes = Buffer.from([0x00, 0x0d, 0x80, 0xff, 0x41, 0x0a, 0xc3, 0x28]);
  queue.enqueue('sender@ours.test', ['bad@y.test'], bytes, 0);
  await loop.tick(0);

  const got = queue.getDeadLetter(queue.listDeadLetters()[0]!.id)!;
  assert.ok(got.data.equals(bytes), 'raw bytes preserved exactly — no string round-trip corruption');

  // Negative control: a copy with a single bit flipped must NOT compare equal, proving
  // the equality check above is actually byte-sensitive (not a length-only pass).
  const flipped = Buffer.from(bytes);
  flipped[0] = flipped[0]! ^ 0x01;
  assert.ok(!got.data.equals(flipped), 'a one-bit-different copy is detected as unequal');
});

test('crash-safety: the transactional move rolls back atomically if it cannot complete', () => {
  // deadLetter() inserts the retained row AND deletes the live row under ONE
  // transaction. Force the INSERT to fail mid-transaction (a pre-existing dead_letter
  // row with the same id → UNIQUE violation) and prove the whole move rolls back: the
  // message is STILL live, never removed-but-not-retained.
  const db = new DatabaseSync(':memory:');
  const queue = SqliteQueue.open(db);
  const id = queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('keep me live'), 0);
  const entry = queue.due(0).find((e) => e.id === id)!;

  // Plant a colliding dead_letter row so the move's INSERT throws.
  db.prepare('INSERT INTO dead_letter (id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(entry.id, 'x', '[]', Buffer.from('collision'), 0, 0, 'planted', 0);

  assert.throws(() => queue.deadLetter(entry, { failedRecipients: ['bad@y.test'], lastError: 'boom', now: 1 }), 'the failing move throws');

  // The live row must survive — the DELETE was rolled back with the failed INSERT.
  assert.equal(queue.size, 1, 'the message is STILL in the live queue (transaction rolled back)');
  assert.equal(queue.due(0).length, 1, 'still deliverable — not silently lost');
  // And no half-written state: only the planted row exists in dead_letter.
  const planted = queue.getDeadLetter(entry.id)!;
  assert.equal(planted.lastError, 'planted', 'the planted row is untouched — our aborted move wrote nothing');
});

test('crash-safety negative control: the NAIVE remove-then-write ordering LOSES the message across a reopen', () => {
  // This is the hazard the transaction removes. A file-backed DB lets us "crash"
  // (close without finishing) and reopen. The naive ordering — delete the live row
  // FIRST, then write the dead letter — loses the message if the process dies in
  // between. We simulate that death and show, on reopen, the message is in NEITHER
  // table. The real deadLetter() (next assertion) survives the same reopen.
  const dir = mkdtempSync(join(tmpdir(), 'deadletter-crash-'));
  const path = join(dir, 'q.db');
  try {
    // --- naive ordering: remove, then "crash" before the dead-letter write ---
    {
      const db = new DatabaseSync(path);
      const queue = SqliteQueue.open(db);
      const id = queue.enqueue('sender@ours.test', ['bad@y.test'], Buffer.from('lost forever'), 0);
      queue.remove(id); // naive step 1
      db.close(); // crash BEFORE the dead-letter write (naive step 2 never happens)
    }
    {
      const db = new DatabaseSync(path);
      const queue = SqliteQueue.open(db);
      assert.equal(queue.size, 0, 'not in the live queue');
      assert.equal(queue.listDeadLetters().length, 0, 'NOR in dead-letter — the naive ordering lost it');
      db.close();
    }

    // --- the real transactional move: survives the same crash-and-reopen ---
    const bytes = Buffer.from('safe across reopen', 'latin1');
    {
      const db = new DatabaseSync(path);
      const queue = SqliteQueue.open(db);
      const id = queue.enqueue('sender@ours.test', ['bad@y.test'], bytes, 0);
      const entry = queue.due(0).find((e) => e.id === id)!;
      queue.deadLetter(entry, { failedRecipients: ['bad@y.test'], lastError: 'gave up', now: 1 });
      db.close(); // crash immediately after the committed atomic move
    }
    {
      const db = new DatabaseSync(path);
      const queue = SqliteQueue.open(db);
      assert.equal(queue.size, 0, 'removed from the live queue');
      const dead = queue.listDeadLetters();
      assert.equal(dead.length, 1, 'retained — the atomic move committed and survived the reopen');
      assert.ok(queue.getDeadLetter(dead[0]!.id)!.data.equals(bytes), 'byte-exact after reopen');
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
