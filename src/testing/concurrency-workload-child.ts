/**
 * Concurrency workload child for src/store/sqlite-concurrency.integration.test.ts.
 *
 * WAL's promise is safe CONCURRENT access to one database file. Proving it needs
 * genuine parallelism, and same-thread node:sqlite handles cannot supply it: JS
 * is single-threaded and each SqliteMailbox #tx runs from BEGIN IMMEDIATE to
 * COMMIT synchronously, so two handles in one process never actually overlap a
 * write — they serialise for free. Real write contention therefore needs
 * separate OS processes, exactly as the crash test uses child processes. This is
 * that child. It opens the SAME file through the PRODUCTION opener (openMailDb →
 * WAL + busy_timeout), so if the busy_timeout fix regresses, these children
 * (and the daemon) start raising SQLITE_BUSY together.
 *
 * Modes (argv[2]):
 *   append  <db> <writerId> <count>   append `count` messages; on each COMMIT emit
 *                                      one stdout line `<uid> <writerId> <seq>`.
 *   flag    <db> <flag> <maxUid>      add `flag` to every uid in 1..maxUid.
 *   expunge <db> <uidsCsv>           expunge each listed uid.
 *   hold    <db> <holdMs>            take the write lock (BEGIN IMMEDIATE), print
 *                                      "holding", keep it for holdMs, then COMMIT.
 *
 * Message bytes for an append are `w<writerId>-s<seq>` (latin1): position- and
 * writer-dependent, so the test can prove each surviving UID maps back to exactly
 * one writer's message (no lost, torn, or misattributed write). Any error —
 * SQLITE_BUSY above all — is written to stderr and the child exits 1, so the
 * parent detects a lost writer.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { openMailDb } from '../store/open-mail-db.ts';

/** The deterministic content a writer appends for its Nth message. */
export function concurrencyContent(writerId: number, seq: number): Buffer {
  return Buffer.from(`w${writerId}-s${seq}`, 'latin1');
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const dbPath = process.argv[3]!;
  const db = openMailDb(dbPath);
  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;

  if (mode === 'append') {
    const writerId = Number(process.argv[4]);
    const count = Number(process.argv[5]);
    const lines: string[] = [];
    for (let seq = 1; seq <= count; seq++) {
      const uid = inbox.append(concurrencyContent(writerId, seq));
      lines.push(`${uid} ${writerId} ${seq}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  } else if (mode === 'flag') {
    const flag = process.argv[4]!;
    const maxUid = Number(process.argv[5]);
    for (let uid = 1; uid <= maxUid; uid++) inbox.storeFlags(uid, 'add', [flag]);
  } else if (mode === 'expunge') {
    for (const u of process.argv[4]!.split(',')) inbox.expunge(Number(u));
  } else if (mode === 'hold') {
    const holdMs = Number(process.argv[4]);
    db.exec('BEGIN IMMEDIATE'); // acquire the single WAL write lock
    db.prepare('UPDATE mailbox SET uid_next = uid_next WHERE id = 1').run();
    process.stdout.write('holding\n'); // parent waits for this before contending
    await sleep(holdMs); // hold the lock (transaction stays open across the await)
    db.exec('COMMIT');
    process.stdout.write('released\n');
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  db.close();
}

void main().catch((e) => {
  process.stderr.write(String((e as Error)?.stack ?? e) + '\n');
  process.exit(1);
});
