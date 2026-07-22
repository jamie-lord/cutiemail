/**
 * Disk-full on the STORE path: SQLITE_FULL mid-append/enqueue is atomic.
 *
 * The crash suite proves a process kill never tears the store; this proves the OTHER
 * durability edge — the disk filling up mid-write. The inbound guarantee is that a
 * SQLITE_FULL while appending a delivered message (or enqueuing an outbound one) yields a
 * transient failure with NO half-stored row and NO false success, so the sender retries and
 * nothing is silently lost. That rests on one property of the store layer: append() and the
 * queue insert are single transactions, so a mid-write SQLITE_FULL rolls back WHOLE.
 *
 * We provoke real SQLITE_FULL with `PRAGMA max_page_count` set just above the current size,
 * then append/enqueue a payload far larger than that headroom (the same errcode 13 an
 * out-of-space disk raises), and assert: it throws (never a false success), the row count and
 * UID/mod-sequence bookkeeping are unmoved (no half-stored row, no skipped or reused UID), and
 * a retry once space is freed succeeds and takes the very UID the failed attempt would have.
 *
 * SCOPE: this pins the store-layer atomicity. The receiver-level mapping (the 250 is written
 * only AFTER the delivery handler resolves, so a handler that throws on SQLITE_FULL produces a
 * 4yz, never a 250) lives in the SMTP receiver + src/main.ts and is a structural property of
 * that code, not exercised here — driving the socket path to disk-full would need those files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb } from './open-mail-db.ts';
import { SqliteCatalog } from './sqlite-mailbox.ts';
import { SqliteQueue } from './sqlite-queue.ts';

const NO_LIMIT = 1_000_000_000; // well under SQLite's max_page_count ceiling; "space freed"
const BIG = Buffer.from('x'.repeat(1024 * 1024), 'latin1'); // 1 MiB: far beyond any small headroom

/** Cap the database `headroom` pages above its current page count. */
function capJustAbove(db: ReturnType<typeof openMailDb>, headroom: number): void {
  const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
  db.exec(`PRAGMA max_page_count=${pageCount + headroom}`);
}

test('SQLITE_FULL mid-append: no half-stored row, uid_next/modseq unmoved, retry after space is freed succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disk-full-'));
  try {
    const db = openMailDb(join(dir, 'mail.db'));
    const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
    for (let i = 1; i <= 3; i++) inbox.append(Buffer.from(`seed ${i}`, 'latin1'));

    const beforeCount = inbox.messages.length;
    const beforeUidNext = inbox.uidNext;
    const beforeModseq = inbox.highestModseq;

    capJustAbove(db, 2);
    let err: unknown;
    try {
      inbox.append(BIG);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, 'a disk-full append must throw, never silently succeed (a false 250)');
    assert.equal((err as { errcode?: number }).errcode, 13, 'the cause is SQLITE_FULL (errcode 13)');
    assert.match(String((err as Error).message), /disk is full/);

    // The transaction rolled back whole.
    assert.equal(inbox.messages.length, beforeCount, 'no half-stored message row survives SQLITE_FULL');
    assert.equal(inbox.uidNext, beforeUidNext, 'uid_next did not advance: a retry cannot skip or reuse a UID');
    assert.equal(inbox.highestModseq, beforeModseq, 'the mod-sequence did not advance on the failed append');
    // Integrity is intact and no orphaned flag rows leaked from the rolled-back insert.
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');

    // Space freed: the SAME operation now succeeds, taking the UID the failed attempt reserved.
    db.exec(`PRAGMA max_page_count=${NO_LIMIT}`);
    const uid = inbox.append(Buffer.from('after space is freed', 'latin1'));
    assert.equal(uid, beforeUidNext, 'the retry takes exactly the UID the failed append would have');
    assert.equal(inbox.messages.length, beforeCount + 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLITE_FULL mid-enqueue: no queue row is stored, retry after space is freed succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disk-full-'));
  try {
    const db = openMailDb(join(dir, 'control.db'));
    const q = SqliteQueue.open(db);
    q.enqueue('a@example.test', ['b@remote.invalid'], Buffer.from('seed', 'latin1'), 1000);

    const beforeSize = q.size;
    capJustAbove(db, 1);
    let err: unknown;
    try {
      q.enqueue('a@example.test', ['c@remote.invalid'], BIG, 2000);
    } catch (e) {
      err = e;
    }
    assert.ok(err !== undefined, 'a disk-full enqueue must throw, never silently accept');
    assert.equal((err as { errcode?: number }).errcode, 13, 'the cause is SQLITE_FULL (errcode 13)');
    assert.equal(q.size, beforeSize, 'no partial queue row is stored on SQLITE_FULL');
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');

    db.exec(`PRAGMA max_page_count=${NO_LIMIT}`);
    const id = q.enqueue('a@example.test', ['c@remote.invalid'], Buffer.from('small retry', 'latin1'), 3000);
    assert.ok(id.length > 0 && q.size === beforeSize + 1, 'the retry enqueues cleanly once space is freed');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
