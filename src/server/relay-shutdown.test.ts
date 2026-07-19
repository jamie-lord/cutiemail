/**
 * Shutdown race (found under mixed load): the relay loop's `stop()` only cleared its interval
 * timer, it did not wait for an IN-FLIGHT tick. So a tick draining a backed-up queue kept running
 * while `close()` went on to close the control database, and the tick's next `queue.due()` hit a
 * closed handle — `Error: database is not open`, an unhandled rejection on every shutdown that had
 * outbound mail queued (i.e. exactly when the box is busy). The fix makes `stop()` await the tick,
 * which bails at the next entry boundary leaving the rest durably queued.
 *
 * This reproduces the race: a slow relay keeps a tick in-flight, then we stop() and close the DB.
 * With the bug, closing under the running tick throws; with the fix, stop() has already drained it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayLoop } from './relay-loop.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { openMailDb } from '../store/open-mail-db.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('stop() awaits the in-flight tick, so the queue DB can be closed without a race', async () => {
  const db = openMailDb(':memory:');
  const queue = SqliteQueue.open(db);
  for (let i = 0; i < 10; i++) queue.enqueue('a@sender.example', ['b@remote.example'], Buffer.from(`m${i}`), 0);

  let started = 0;
  let finished = 0;
  // A deliberately slow relay so a tick is mid-drain when we stop — one entry in flight at a time.
  const relay = async (msg: { recipients: readonly string[] }): Promise<Array<{ recipient: string; ok: boolean; classification: 'success'; detail: string }>> => {
    started++;
    await delay(25);
    finished++;
    return msg.recipients.map((recipient) => ({ recipient, ok: true, classification: 'success' as const, detail: 'sent' }));
  };
  const loop = new RelayLoop(queue, relay);

  loop.start(5); // fast interval so a tick begins promptly
  await delay(20); // a tick is now in-flight (inside the 25 ms relay of the first entry)
  assert.ok(started >= 1, 'a tick is draining when we stop');

  await loop.stop(); // MUST wait for the in-flight entry to finish before returning
  assert.equal(finished, started, 'stop() waited: no relay was left dangling mid-flight');

  // The whole point: closing the DB now cannot be raced by a tick touching it.
  db.close();
  await delay(40); // give any errant timer/tick a chance to fire against the closed DB

  // Reaching here without an unhandled "database is not open" rejection is the assertion; node's
  // test runner fails the test on an unhandled rejection, so a clean finish proves the fix.
  // The bail left the rest durably queued (they were never relayed) — not all 10 went out.
  assert.ok(started < 10, 'stop() bailed mid-drain, leaving the remaining rows queued for next start');
});
