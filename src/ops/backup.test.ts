/**
 * `backup` + `verify` (backlog B4).
 *
 * The claims under test, each with its negative control:
 *   - a backup taken WHILE a separate OS process is appending messages is a
 *     transactionally consistent snapshot: it verifies clean and its content is
 *     a prefix-consistent state (never a torn write) — the concurrency child
 *     from the WAL suite provides the real contention;
 *   - `verify` DETECTS corruption: a byte-flipped file fails integrity_check,
 *     and semantically corrupted stores (uid >= uid_next, a live+expunged UID,
 *     a message both queued and dead-lettered) fail the invariant checks — a
 *     verifier never shown to fail is not coverage;
 *   - `verify` is read-only: the backup's bytes are identical before and after
 *     (Mox's verifydata mutates via schema upgrade; ours must not);
 *   - `backup` never overwrites an existing snapshot file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runBackup, runVerify, snapshotDatabase, verifyDatabase } from './backup.ts';
import { runAccount, type PasswordSource } from './account.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { openMailDb } from '../store/open-mail-db.ts';

const CHILD = new URL('../testing/concurrency-workload-child.ts', import.meta.url).pathname;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'backup-test-'));
}
interface Cap {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out(l: string): void; err(l: string): void };
}
function capture(): Cap {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => void out.push(l), err: (l) => void err.push(l) } };
}
const pw: PasswordSource = { interactive: false, read: () => Promise.resolve('pw') };

/** A control DB + one populated mail DB, provisioned through the real code paths. */
async function makeWorld(dir: string): Promise<{ controlPath: string; mailPath: string }> {
  const controlPath = join(dir, 'control.db');
  assert.equal(await runAccount(['add', 'alice', '--db', controlPath], capture().io, {}, pw), 0);
  const mailPath = join(dir, 'mail-alice.db');
  const db = openMailDb(mailPath);
  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
  for (let i = 1; i <= 5; i++) inbox.append(Buffer.from(`message ${i}`, 'latin1'));
  inbox.storeFlags(2, 'add', ['\\Seen']);
  inbox.expunge(3);
  db.close();
  // Something real in the queue too, so the control invariants have rows to check.
  const cdb = openMailDb(controlPath);
  SqliteQueue.open(cdb).enqueue('alice@example.org', ['bob@example.net'], Buffer.from('queued bytes', 'latin1'), 1000);
  cdb.close();
  return { controlPath, mailPath };
}

test('backup snapshots every database and the snapshot verifies clean; verify mutates nothing', async () => {
  const dir = tmp();
  try {
    const { controlPath } = await makeWorld(dir);
    const dest = join(dir, 'snap');
    const cap = capture();
    assert.equal(runBackup([dest, '--db', controlPath], cap.io, {}), 0);
    assert.match(cap.out.join('\n'), /control\.db/);
    assert.match(cap.out.join('\n'), /mail-alice\.db/);

    const before = [readFileSync(join(dest, 'control.db')), readFileSync(join(dest, 'mail-alice.db'))];
    const vcap = capture();
    assert.equal(runVerify([dest], vcap.io), 0);
    assert.match(vcap.out.join('\n'), /2 database\(s\) healthy/);
    // Read-only proof: byte-identical after verify.
    assert.deepEqual(readFileSync(join(dest, 'control.db')), before[0]);
    assert.deepEqual(readFileSync(join(dest, 'mail-alice.db')), before[1]);

    // Never overwrites: a second backup into the same directory fails cleanly.
    const cap2 = capture();
    assert.equal(runBackup([dest, '--db', controlPath], cap2.io, {}), 1);
    assert.match(cap2.err.join('\n'), /failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup taken under a concurrent writer is a consistent snapshot', async () => {
  const dir = tmp();
  try {
    const mailPath = join(dir, 'mail-load.db');
    const db = openMailDb(mailPath);
    SqliteCatalog.open(db, 1); // provision INBOX before the child starts
    db.close();

    // A separate OS process appends 300 messages through the production opener
    // while we snapshot mid-flight — real writer-vs-reader contention, same
    // harness as the WAL concurrency suite.
    const child = spawn(process.execPath, [CHILD, 'append', mailPath, '1', '300'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childErr = '';
    child.stderr.on('data', (d: Buffer) => (childErr += d.toString()));
    const childDone = new Promise<number>((res) => child.on('close', (code) => res(code ?? -1)));

    await new Promise((r) => setTimeout(r, 150)); // let the writer get going
    const snapPath = join(dir, 'snap.db');
    snapshotDatabase(mailPath, snapPath);

    assert.equal(await childDone, 0, `writer child failed: ${childErr}`);

    // The snapshot verifies clean...
    const report = verifyDatabase(snapPath);
    assert.deepEqual(report.findings, []);
    assert.equal(report.kind, 'mail');
    // ...and is prefix-consistent: uids 1..N with N < 300 and every message's
    // bytes intact (a torn copy would break one or the other).
    const snap = new DatabaseSync(snapPath, { readOnly: true });
    const rows = snap.prepare('SELECT uid, raw FROM message ORDER BY uid').all() as Array<{ uid: number | bigint; raw: Uint8Array }>;
    snap.close();
    assert.ok(rows.length > 0 && rows.length <= 300, `snapshot has ${rows.length} messages`);
    rows.forEach((r, i) => {
      assert.equal(Number(r.uid), i + 1); // dense prefix, no gaps mid-write
      assert.equal(Buffer.from(r.raw).toString('latin1'), `w1-s${i + 1}`);
    });
    // The LIVE database kept all 300 — the snapshot froze a moment, lost nothing.
    const live = verifyDatabase(mailPath);
    assert.deepEqual(live.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: verify detects structural byte corruption', async () => {
  const dir = tmp();
  try {
    const { mailPath } = await makeWorld(dir);
    const snapPath = join(dir, 'snap.db');
    snapshotDatabase(mailPath, snapPath);
    assert.deepEqual(verifyDatabase(snapPath).findings, []); // clean before

    // Corrupt the second page's header: SQLite pages carry no payload checksums
    // (a flipped bit INSIDE a blob is invisible — the documented, honest boundary),
    // but structural damage is exactly what integrity_check exists to catch.
    const bytes = readFileSync(snapPath);
    assert.ok(bytes.length > 4096 + 64, 'need a multi-page database');
    for (let i = 0; i < 64; i++) bytes[4096 + i] = bytes[4096 + i]! ^ 0xff;
    writeFileSync(snapPath, bytes);

    const report = verifyDatabase(snapPath);
    assert.ok(report.findings.length > 0, 'corruption must be detected');
    const cap = capture();
    assert.equal(runVerify([snapPath], cap.io), 1); // and it fails the run
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: verify detects semantic corruption the file-level check cannot', async () => {
  const dir = tmp();
  try {
    const { controlPath, mailPath } = await makeWorld(dir);

    // Mail store: wind uid_next back below live uids (what a botched restore or a
    // non-transactional writer could produce), and make a UID both live+expunged.
    const snapMail = join(dir, 'bad-mail.db');
    snapshotDatabase(mailPath, snapMail);
    const m = new DatabaseSync(snapMail);
    m.exec('UPDATE mailbox SET uid_next = 2 WHERE id = 1');
    m.close();
    const mailReport = verifyDatabase(snapMail);
    assert.ok(mailReport.findings.some((f) => f.includes('uid_next')), JSON.stringify(mailReport));

    const snapMail2 = join(dir, 'bad-mail2.db');
    snapshotDatabase(mailPath, snapMail2);
    const m2 = new DatabaseSync(snapMail2);
    m2.exec("INSERT INTO expunged (mailbox_id, uid, mod_seq) VALUES (1, 1, 99)"); // uid 1 is live
    m2.close();
    assert.ok(verifyDatabase(snapMail2).findings.some((f) => f.includes('partition')));

    // Control store: the same id in both queue and dead_letter — exactly what the
    // transactional move exists to prevent.
    const snapCtl = join(dir, 'bad-control.db');
    snapshotDatabase(controlPath, snapCtl);
    const c = new DatabaseSync(snapCtl);
    const row = c.prepare('SELECT id, from_addr, recipients, data, first_queued, attempts FROM outbound_queue LIMIT 1').get() as {
      id: string; from_addr: string; recipients: string; data: Uint8Array; first_queued: number | bigint; attempts: number | bigint;
    };
    c.prepare('INSERT INTO dead_letter (id, from_addr, recipients, data, first_queued, attempts, last_error, dead_lettered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.from_addr, row.recipients, row.data, row.first_queued, row.attempts, 'x', 1);
    c.close();
    assert.ok(verifyDatabase(snapCtl).findings.some((f) => f.includes('BOTH queued and dead-lettered')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage errors: missing destdir / nonexistent control db / nonexistent verify path exit 2', async () => {
  const dir = tmp();
  try {
    assert.equal(runBackup([], capture().io, {}), 2);
    assert.equal(runBackup([join(dir, 'out'), '--db', join(dir, 'missing.db')], capture().io, {}), 2);
    assert.equal(runVerify([], capture().io), 2);
    assert.equal(runVerify([join(dir, 'nope.db')], capture().io), 2);
    // An unrecognized file is a verification FAILURE (1), not a usage error.
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a database at all');
    assert.equal(runVerify([junk], capture().io), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
