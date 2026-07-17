/**
 * Crash consistency: SIGKILL a process mutating the store, reopen the database
 * file, and prove nothing tore.
 *
 * "The SQLite of email" is a durability claim, and this is the test that backs
 * it at process-crash granularity. A child process (crash-workload-child.ts)
 * drives the PRODUCTION open path (WAL + SqliteCatalog) through a mixed
 * append/flag/expunge workload and confirms each committed operation with a
 * synchronous write to an ops file; the test kills it at varying points and
 * verifies, on reopen:
 *
 *   1. the database passes PRAGMA integrity_check;
 *   2. every surviving message blob byte-equals its deterministic content —
 *      no torn or misattributed write survives;
 *   3. UIDs are strictly ascending and uid_next stays ahead of them all;
 *   4. surviving UIDs and the QRESYNC expunge log PARTITION {1..maxUid} —
 *      disjoint, together complete. This is the cross-table invariant a torn
 *      multi-statement transaction would break (message deleted but never
 *      logged → a QRESYNC client never learns it vanished; logged but not
 *      deleted → a message both present and vanished);
 *   5. no CONFIRMED operation is lost, and at most ONE unconfirmed operation
 *      is visible beyond them (the one between COMMIT and its confirmation);
 *   6. highest_modseq ≥ every mod_seq in messages and the expunge log; and
 *   7. the reopened mailbox still works: a fresh append gets a fresh, higher
 *      UID.
 *
 * RECORDED SCOPE: this covers process crash (kill -9), where committed WAL
 * data survives in the kernel page cache. It does NOT cover power loss —
 * WAL + synchronous=NORMAL deliberately trades an fsync per commit for the
 * possibility of losing the last commits on power failure (never corruption).
 * That is SQLite's documented, chosen trade-off, not an untested gap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCatalog } from './sqlite-mailbox.ts';
import { crashContent } from '../testing/crash-workload-child.ts';

const CHILD = new URL('../testing/crash-workload-child.ts', import.meta.url).pathname;

interface Confirmed {
  appends: number[];
  flags: number[];
  expunges: number[];
}

function parseOps(opsPath: string): Confirmed {
  const out: Confirmed = { appends: [], flags: [], expunges: [] };
  if (!existsSync(opsPath)) return out;
  for (const line of readFileSync(opsPath, 'latin1').split('\n')) {
    const [op, uidText] = line.split(' ');
    if (op === undefined || uidText === undefined) continue;
    const uid = Number(uidText);
    if (op === 'a') out.appends.push(uid);
    else if (op === 'f') out.flags.push(uid);
    else if (op === 'x') out.expunges.push(uid);
  }
  return out;
}

/** Run the workload child, kill it after `minOps` confirmed ops + `extraMs`, return its ops. */
async function runAndKill(dbPath: string, opsPath: string, minOps: number, extraMs: number): Promise<Confirmed> {
  const child = spawn(process.execPath, [CHILD, 'run', dbPath, opsPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  let exitedEarly = false;
  void exited.then(() => (exitedEarly = true));

  // Wait until the child has confirmed enough operations to prove the
  // workload is genuinely running (anti-vacuous-pass guard).
  const deadline = Date.now() + 20_000;
  for (;;) {
    const n = parseOps(opsPath);
    if (n.appends.length + n.flags.length + n.expunges.length >= minOps) break;
    assert.ok(!exitedEarly, `workload child exited on its own before the kill:\n${stderr}`);
    assert.ok(Date.now() < deadline, `workload child too slow to reach ${minOps} ops:\n${stderr}`);
    await sleep(10);
  }
  await sleep(extraMs);
  assert.ok(!exitedEarly, `workload child exited on its own before the kill:\n${stderr}`);
  child.kill('SIGKILL');
  await exited;
  return parseOps(opsPath);
}

function verifyReopened(dbPath: string, confirmed: Confirmed): void {
  // The production open path again.
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');

  // 1. Structural integrity.
  const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(check.integrity_check, 'ok');

  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
  const messages = inbox.messages;

  // 2. No torn blob: every survivor byte-equals its deterministic content.
  for (const m of messages) {
    assert.ok(m.raw.equals(crashContent(m.uid)), `message uid=${m.uid} bytes are torn or misattributed`);
  }

  // 3. Strictly ascending UIDs; uid_next ahead of all of them.
  const uids = messages.map((m) => m.uid);
  for (let i = 1; i < uids.length; i++) assert.ok(uids[i]! > uids[i - 1]!, 'UIDs not strictly ascending');
  const expungedRows = db.prepare('SELECT uid, mod_seq FROM expunged WHERE mailbox_id = 1 ORDER BY uid').all() as Array<{ uid: number; mod_seq: number }>;
  const loggedUids = expungedRows.map((r) => Number(r.uid));
  const maxUid = Math.max(0, ...uids, ...loggedUids);
  assert.ok(inbox.uidNext > maxUid, `uid_next ${inbox.uidNext} not ahead of max seen uid ${maxUid}`);

  // 4. Partition invariant: surviving ∪ expunge-log = {1..maxUid}, disjoint.
  const present = new Set(uids);
  const logged = new Set(loggedUids);
  for (const u of logged) assert.ok(!present.has(u), `uid=${u} is both present and in the expunge log`);
  for (let u = 1; u <= maxUid; u++) {
    assert.ok(present.has(u) || logged.has(u), `uid=${u} vanished without an expunge-log entry`);
  }

  // 5. Durability floor and in-flight ceiling. Every CONFIRMED operation
  //    committed before the kill, so it must be visible; sequential confirmation
  //    means at most one operation beyond the confirmed set can have committed.
  const lastConfirmedAppend = Math.max(0, ...confirmed.appends);
  assert.ok(maxUid >= lastConfirmedAppend, `confirmed append uid=${lastConfirmedAppend} lost (max seen ${maxUid})`);
  assert.ok(maxUid <= lastConfirmedAppend + 1, `more than one unconfirmed append visible (${maxUid} > ${lastConfirmedAppend} + 1)`);
  for (const u of confirmed.expunges) {
    assert.ok(logged.has(u), `confirmed expunge uid=${u} missing from the expunge log`);
  }
  const unconfirmedExpunges = loggedUids.filter((u) => !confirmed.expunges.includes(u));
  assert.ok(unconfirmedExpunges.length <= 1, `more than one unconfirmed expunge visible: ${unconfirmedExpunges}`);
  const flagsByUid = new Map(messages.map((m) => [m.uid, m.flags]));
  for (const u of confirmed.flags) {
    const f = flagsByUid.get(u);
    if (f === undefined) continue; // later expunged — flags legitimately gone
    assert.ok(f.has('\\Seen') && f.has(`$crash${u}`), `confirmed flag store on uid=${u} lost`);
  }

  // 6. Mod-sequence coherence across tables.
  const highest = inbox.highestModseq;
  for (const m of messages) assert.ok(m.modseq <= highest, `message modseq ${m.modseq} exceeds highest ${highest}`);
  for (const r of expungedRows) assert.ok(Number(r.mod_seq) <= highest, `expunge-log modseq ${r.mod_seq} exceeds highest ${highest}`);

  // 7. Still a working mailbox: a fresh append lands beyond everything seen.
  const newUid = inbox.append(Buffer.from('post-crash append\r\n', 'latin1'));
  assert.ok(newUid > maxUid, `post-crash append uid ${newUid} not beyond ${maxUid}`);
  db.close();
}

// ─── Negative controls: prove the verifier DETECTS each corruption class ────
// A crash test whose checks cannot fail is no test at all. Build a healthy
// store with the real API, tamper it the way a torn transaction would, and
// assert the exact invariant trips.

function buildSmallStore(dbPath: string): Confirmed {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
  for (let i = 1; i <= 5; i++) inbox.append(crashContent(i));
  inbox.expunge(2);
  db.close();
  return { appends: [1, 2, 3, 4, 5], flags: [], expunges: [2] };
}

test('negative control: a torn blob is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-nc-'));
  const dbPath = join(dir, 'torn.db');
  const confirmed = buildSmallStore(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE message SET raw = ? WHERE mailbox_id = 1 AND uid = 3').run(Buffer.from('torn!', 'latin1'));
  db.close();
  assert.throws(() => verifyReopened(dbPath, confirmed), /torn or misattributed/);
});

test('negative control: an expunge that vanished from the log is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-nc-'));
  const dbPath = join(dir, 'unlogged.db');
  const confirmed = buildSmallStore(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM expunged WHERE mailbox_id = 1 AND uid = 2').run();
  db.close();
  assert.throws(() => verifyReopened(dbPath, confirmed), /vanished without an expunge-log entry/);
});

test('negative control: a lost committed append is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-nc-'));
  const dbPath = join(dir, 'lost.db');
  const confirmed = buildSmallStore(dbPath);
  const db = new DatabaseSync(dbPath);
  // Simulate "insert lost but confirmation written": drop the last message row.
  db.prepare('DELETE FROM message WHERE mailbox_id = 1 AND uid = 5').run();
  db.close();
  assert.throws(() => verifyReopened(dbPath, confirmed), /confirmed append uid=5 lost|vanished without an expunge-log entry/);
});

test('kill -9 mid-workload: store reopens intact, committed ops survive, nothing tears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-'));
  // Vary how deep into the workload the kill lands: right after the threshold,
  // and at increasing extra delays that let large-blob appends be in flight.
  const runs: Array<[minOps: number, extraMs: number]> = [
    [6, 0],
    [12, 35],
    [20, 80],
    [30, 140],
  ];
  for (const [i, [minOps, extraMs]] of runs.entries()) {
    const dbPath = join(dir, `crash-${i}.db`);
    const opsPath = join(dir, `crash-${i}.ops`);
    const confirmed = await runAndKill(dbPath, opsPath, minOps, extraMs);
    // Anti-vacuous-pass: the workload must have genuinely run before the kill.
    assert.ok(confirmed.appends.length >= 4, `iteration ${i}: workload barely ran (${confirmed.appends.length} appends)`);
    verifyReopened(dbPath, confirmed);
  }
});
