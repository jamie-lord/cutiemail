/**
 * WAL concurrency: prove the SQLite store behaves correctly under CONCURRENT
 * access — the promise that made WAL worth choosing. (Crash consistency, the
 * OTHER half of the durability story, is covered separately by
 * sqlite-crash.integration.test.ts; this file deliberately does not touch it.)
 *
 * WAL allows readers and writers to proceed in parallel, but permits only ONE
 * writer at a time. Correctness under contention therefore rests on two things:
 *   - every mutation runs in a BEGIN IMMEDIATE transaction (SqliteMailbox #tx),
 *     so it is atomic and serialised against other writers; and
 *   - the connection is opened with a busy_timeout (openMailDb), so a writer
 *     that finds the write lock held WAITS rather than getting SQLITE_BUSY.
 *
 * Genuine write contention cannot be produced by two handles in one process
 * (JS is single-threaded; each #tx runs BEGIN→COMMIT synchronously and so two
 * handles never overlap a write). So the writer-vs-writer tests spawn separate
 * OS processes (concurrency-workload-child.ts) that open the same file through
 * the PRODUCTION opener. The reader-snapshot test, by contrast, needs no second
 * process: WAL snapshot isolation is a property of one connection's read
 * transaction against another connection's commit, observable in-process.
 *
 * Every assertion has a NEGATIVE CONTROL demonstrating it can fail:
 *   - the busy_timeout test itself contains the pre-fix path (busy_timeout=0),
 *     which is shown to raise SQLITE_BUSY on the same contention the fixed path
 *     survives;
 *   - the UID-partition and lost-flag checks are exercised against tampered
 *     inputs (a duplicate UID, a gap, a stripped flag, a broken expunge log) and
 *     shown to throw — a duplicate UID is exactly what a non-transactional
 *     read-modify-write of uid_next would produce;
 *   - the snapshot-isolation test pairs the frozen in-transaction read with an
 *     autocommit read that DOES observe the commit, proving the equality it
 *     asserts is non-vacuous.
 *
 * Spec: SQLite WAL (https://sqlite.org/wal.html), PRAGMA busy_timeout
 * (https://sqlite.org/pragma.html#pragma_busy_timeout); IMAP UID monotonicity
 * and non-reuse RFC 9051 §2.3.1.1; QRESYNC VANISHED / expunge log RFC 7162.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCatalog } from './sqlite-mailbox.ts';
import { openMailDb, BUSY_TIMEOUT_MS } from './open-mail-db.ts';

const CHILD = new URL('../testing/concurrency-workload-child.ts', import.meta.url).pathname;

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a workload child, resolve with its exit code and captured streams. */
function runChild(args: string[], onStdout?: (line: string) => void): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      onStdout?.(d.toString());
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Create the database file + INBOX through the production opener, then close it. */
function seedInbox(dbPath: string): void {
  const db = openMailDb(dbPath);
  SqliteCatalog.open(db, 1);
  db.close();
}

function countMessages(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM message WHERE mailbox_id = 1').get() as { n: number }).n);
}

/**
 * The IMAP UID invariant under contention: the set of assigned UIDs must be
 * EXACTLY {1..total} — distinct (no collision → no reuse), gapless (no lost
 * append), which taken in order means strictly ascending. Throws with a specific
 * message per failure mode so the negative controls can pin down which broke.
 */
function assertUidPartition(uids: number[], total: number): void {
  assert.equal(uids.length, total, `expected ${total} UIDs, got ${uids.length} (a lost or duplicated append)`);
  const set = new Set(uids);
  assert.equal(set.size, uids.length, 'duplicate UID assigned — two appends collided on one uid');
  const sorted = [...uids].sort((a, b) => a - b);
  for (let i = 0; i < total; i++) {
    assert.equal(sorted[i], i + 1, `UIDs are not the contiguous ascending range 1..${total} (missing ${i + 1})`);
  }
}

// ─── busy_timeout is load-bearing (real cross-process lock contention) ──────
// A holder process takes and keeps the single WAL write lock. A second
// connection then tries to begin a write. With busy_timeout=0 (the state of the
// production opener BEFORE this fix) it fails instantly with SQLITE_BUSY — the
// NEGATIVE CONTROL. With the production busy_timeout it blocks, waits out the
// holder, and succeeds — the fix.
test('a contended writer waits under busy_timeout but fails fast without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conc-busy-'));
  try {
    const dbPath = join(dir, 'busy.db');
    seedInbox(dbPath);

    // Sanity: the production opener actually sets the busy timeout we rely on.
    const probe = openMailDb(dbPath);
    const timeout = Number(Object.values(probe.prepare('PRAGMA busy_timeout').get() as object)[0]);
    assert.equal(timeout, BUSY_TIMEOUT_MS, 'openMailDb must configure busy_timeout');
    probe.close();

    // A separate process grabs the write lock and holds it for ~1s.
    let holding = false;
    const holder = runChild(['hold', dbPath, '1000'], (s) => {
      if (s.includes('holding')) holding = true;
    });
    const deadline = Date.now() + 5000;
    while (!holding) {
      assert.ok(Date.now() < deadline, 'holder never acquired the write lock');
      await new Promise((r) => setTimeout(r, 5));
    }

    // NEGATIVE CONTROL — the pre-fix behaviour. A writer with busy_timeout=0 hits
    // the held lock and raises SQLITE_BUSY at once, with no wait.
    const noTimeout = new DatabaseSync(dbPath);
    noTimeout.exec('PRAGMA journal_mode=WAL');
    noTimeout.exec('PRAGMA busy_timeout=0');
    assert.throws(
      () => noTimeout.exec('BEGIN IMMEDIATE'),
      /SQLITE_BUSY|database is locked/i,
      'without busy_timeout a contended writer should fail immediately',
    );
    noTimeout.close();

    // THE FIX — a writer opened the production way blocks on the held lock and
    // succeeds once the holder commits, rather than raising SQLITE_BUSY. The
    // elapsed time proves it genuinely waited instead of racing in first.
    const fixed = openMailDb(dbPath);
    const started = Date.now();
    fixed.exec('BEGIN IMMEDIATE'); // blocks until the holder releases (~1s)
    const waited = Date.now() - started;
    fixed.exec('ROLLBACK');
    fixed.close();
    assert.ok(waited >= 300, `busy_timeout writer should have waited for the lock, waited only ${waited}ms`);

    const h = await holder;
    assert.equal(h.code, 0, `holder exited nonzero: ${h.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── negative control for the UID-partition verifier ────────────────────────
// The invariant checker must actually detect a collision or a loss, or the
// concurrent-append test below could pass for the wrong reason.
test('negative control: the UID-partition check detects collisions and gaps', () => {
  // A duplicate uid (what a non-transactional read-then-write of uid_next produces).
  assert.throws(() => assertUidPartition([1, 2, 2, 4], 4), /duplicate UID|contiguous/);
  // A lost append (a gap in the range).
  assert.throws(() => assertUidPartition([1, 2, 4], 3), /expected 3 UIDs|contiguous/);
  // The happy path does not throw.
  assert.doesNotThrow(() => assertUidPartition([3, 1, 2, 4], 4));
});

// ─── concurrent appends: no lost message, no UID collision ──────────────────
// Two writers in separate processes append to one INBOX at the same time. WAL +
// busy_timeout + per-append transaction must yield exactly 2N messages whose
// UIDs partition {1..2N}, with each stored blob byte-matching the writer that
// produced it (no torn or misattributed write). The negative control above
// proves the partition check would catch a collision or loss.
test('two writers appending concurrently never lose a message or collide on a UID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conc-append-'));
  try {
    const N = 150;
    const dbPath = join(dir, 'append.db');
    seedInbox(dbPath);

    const [a, b] = await Promise.all([
      runChild(['append', dbPath, '1', String(N)]),
      runChild(['append', dbPath, '2', String(N)]),
    ]);
    assert.equal(a.code, 0, `writer 1 failed (SQLITE_BUSY under contention?):\n${a.stderr}`);
    assert.equal(b.code, 0, `writer 2 failed (SQLITE_BUSY under contention?):\n${b.stderr}`);

    // Reconstruct (uid -> intended content) from both writers' confirmations.
    const intended = new Map<number, string>();
    for (const { stdout } of [a, b]) {
      for (const line of stdout.trim().split('\n')) {
        const [uid, writerId, seq] = line.split(' ');
        intended.set(Number(uid), `w${writerId}-s${seq}`);
      }
    }

    // The IMAP UID invariant: exactly {1..2N}, distinct and gapless.
    assertUidPartition([...intended.keys()], 2 * N);

    // Every stored message byte-matches the writer that appended it — proof no
    // write was torn, dropped, or misattributed across the two connections.
    const db = openMailDb(dbPath);
    const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
    assert.equal(inbox.messages.length, 2 * N, 'not every appended message persisted');
    for (const m of inbox.messages) {
      assert.equal(m.raw.toString('latin1'), intended.get(m.uid), `uid ${m.uid} bytes do not match its writer`);
    }
    // uid_next stays ahead of every assigned UID (monotonic allocator survived contention).
    assert.ok(inbox.uidNext > 2 * N, `uid_next ${inbox.uidNext} not ahead of max uid ${2 * N}`);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── reader snapshot isolation: no torn read while a writer commits ──────────
// A reader in a WAL read transaction sees a stable snapshot; a concurrent
// writer's commit is invisible until the reader ends its transaction. The
// NEGATIVE CONTROL is the paired autocommit read: with no snapshot held, the
// very same reader connection observes the commit at once — so the "unchanged"
// assertion is only true because the snapshot held it, not for some trivial
// reason like the write never landing.
test('a reader sees a consistent snapshot while another connection commits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conc-snap-'));
  try {
    const dbPath = join(dir, 'snap.db');
    const reader = openMailDb(dbPath);
    const writer = openMailDb(dbPath);
    const rInbox = SqliteCatalog.open(reader, 1).get('INBOX')!;
    const wInbox = SqliteCatalog.open(writer, 1).get('INBOX')!;
    void rInbox;
    for (let i = 0; i < 3; i++) wInbox.append(Buffer.from(`seed${i}`, 'latin1'));

    // Reader opens a read transaction; the first SELECT fixes its snapshot.
    reader.exec('BEGIN');
    const before = countMessages(reader);
    assert.equal(before, 3);

    // A DIFFERENT connection commits two appends while the reader's txn is open.
    wInbox.append(Buffer.from('late-1', 'latin1'));
    wInbox.append(Buffer.from('late-2', 'latin1'));

    // Still inside the same transaction: the reader must see its frozen snapshot,
    // NOT the writer's just-committed rows — a torn read would show 5 here.
    const during = countMessages(reader);
    assert.equal(during, before, 'WAL reader saw a concurrent commit mid-transaction (torn read)');

    // End the snapshot: only now do the committed rows become visible.
    reader.exec('COMMIT');
    const after = countMessages(reader);
    assert.equal(after, before + 2, 'committed writes never became visible after the snapshot ended');

    // NEGATIVE CONTROL: with no read transaction held, the same reader connection
    // observes a fresh commit immediately. This is what `during == before` would
    // have looked like had the snapshot NOT isolated the read — proving that
    // equality was meaningful, not vacuous.
    const autoBefore = countMessages(reader);
    wInbox.append(Buffer.from('late-3', 'latin1'));
    const autoAfter = countMessages(reader);
    assert.equal(autoAfter, autoBefore + 1, 'an autocommit reader should observe a fresh commit at once');

    reader.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── concurrent flag STORE + expunge from two connections converge ──────────
// Two writer processes hit one populated INBOX at once: one adds a flag to every
// message, the other expunges the even UIDs. With BEGIN IMMEDIATE + busy_timeout
// they serialise without deadlock (both exit 0) and without lost updates. On
// reopen the QRESYNC expunge log must stay consistent: surviving UIDs and logged
// UIDs partition the original set, disjointly.
test('concurrent flag updates and expunges converge with a consistent QRESYNC log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conc-flagx-'));
  try {
    const M = 40;
    const dbPath = join(dir, 'flagx.db');
    // Seed M messages, each with a base flag that must survive the concurrent STORE.
    const seed = openMailDb(dbPath);
    const seedInboxHandle = SqliteCatalog.open(seed, 1).get('INBOX')!;
    for (let i = 1; i <= M; i++) seedInboxHandle.append(Buffer.from(`m${i}`, 'latin1'), ['\\Seen']);
    seed.close();

    const evens = Array.from({ length: M / 2 }, (_, k) => (k + 1) * 2);
    const [flagRes, expungeRes] = await Promise.all([
      runChild(['flag', dbPath, '$conc', String(M)]),
      runChild(['expunge', dbPath, evens.join(',')]),
    ]);
    // No deadlock, no SQLITE_BUSY: both writers ran to completion.
    assert.equal(flagRes.code, 0, `flag writer failed:\n${flagRes.stderr}`);
    assert.equal(expungeRes.code, 0, `expunge writer failed:\n${expungeRes.stderr}`);

    const db = openMailDb(dbPath);
    const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
    const present = new Set(inbox.messages.map((m) => m.uid));
    const logged = new Set(
      (db.prepare('SELECT uid FROM expunged WHERE mailbox_id = 1').all() as Array<{ uid: number }>).map((r) => Number(r.uid)),
    );

    // Every even UID was expunged and logged; every odd UID survives. No lost
    // update: surviving messages keep BOTH the seeded flag and the concurrently
    // added one (the STORE was not clobbered by the concurrent expunge txns).
    for (let uid = 1; uid <= M; uid++) {
      if (uid % 2 === 0) {
        assert.ok(!present.has(uid), `even uid ${uid} should have been expunged`);
        assert.ok(logged.has(uid), `expunged uid ${uid} missing from the QRESYNC log`);
      } else {
        assert.ok(present.has(uid), `odd uid ${uid} should have survived`);
        const flags = inbox.messages.find((m) => m.uid === uid)!.flags;
        assert.ok(flags.has('\\Seen'), `odd uid ${uid} lost its seeded flag under contention`);
        assert.ok(flags.has('$conc'), `odd uid ${uid} lost the concurrently-added flag (lost update)`);
      }
    }

    // The cross-table partition (same invariant the crash test guards, here under
    // CONCURRENT mutation): present ∪ logged == {1..M}, disjoint.
    const checkPartition = (): void => {
      for (const u of logged) assert.ok(!present.has(u), `uid ${u} is both present and in the expunge log`);
      for (let u = 1; u <= M; u++) assert.ok(present.has(u) || logged.has(u), `uid ${u} vanished without an expunge-log entry`);
    };
    checkPartition();

    // Mod-sequences stay coherent: nothing exceeds highest_modseq (RFC 7162).
    const highest = inbox.highestModseq;
    for (const m of inbox.messages) assert.ok(m.modseq <= highest, `message modseq ${m.modseq} exceeds highest ${highest}`);

    // NEGATIVE CONTROL A (lost update): strip the concurrently-added flag from a
    // surviving message and confirm the "flag not lost" assertion would trip.
    const survivor = inbox.messages.find((m) => m.uid % 2 === 1)!;
    assert.ok(survivor.flags.has('$conc'));
    db.prepare('DELETE FROM flag WHERE mailbox_id = 1 AND uid = ? AND flag = ?').run(survivor.uid, '$conc');
    const reread = SqliteCatalog.open(db, 1).get('INBOX')!.messages.find((m) => m.uid === survivor.uid)!;
    assert.throws(
      () => assert.ok(reread.flags.has('$conc'), 'lost update'),
      /lost update/,
      'the lost-update check must detect a stripped flag',
    );

    // NEGATIVE CONTROL B (broken QRESYNC log): drop one expunge-log row and
    // confirm the partition check trips (a message that vanished with no log
    // entry — a QRESYNC client would never learn it was expunged).
    const anEven = evens[0]!;
    logged.delete(anEven);
    assert.throws(checkPartition, /vanished without an expunge-log entry/, 'the partition check must detect a missing log entry');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
