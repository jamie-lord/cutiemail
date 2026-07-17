/**
 * Crash-consistency workload child: a subprocess the crash test SIGKILLs
 * mid-flight (src/store/sqlite-crash.integration.test.ts).
 *
 * Opens the database exactly the way the production daemon does (DatabaseSync →
 * PRAGMA journal_mode=WAL → SqliteCatalog.open → INBOX) and mutates it forever:
 * append every step, a flag STORE every 3rd, an expunge every 5th. It never
 * exits on its own — every death is a kill mid-workload, so the test cannot
 * vacuously pass against an idle process.
 *
 * Confirmation protocol: after each mutating call RETURNS (i.e. after COMMIT),
 * one line is appended to the ops file with fs.writeSync on a raw fd — a
 * synchronous write syscall, so the line is in the file's page cache before the
 * next statement runs and survives SIGKILL (page cache belongs to the kernel,
 * not the process). At most ONE operation can ever be committed-but-unconfirmed:
 * the one between its COMMIT and its writeSync when the kill lands.
 *
 *   a <uid>   append committed        f <uid>  flag store committed
 *   x <uid>   expunge committed
 */

import { DatabaseSync } from 'node:sqlite';
import { openSync, writeSync } from 'node:fs';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';

/**
 * Deterministic message bytes for a UID — position-dependent so a torn or
 * misattributed blob can't accidentally byte-match. Every 5th message is ~1 MiB
 * to widen the in-transaction window the kill can land in; the rest stay small
 * so many transactions happen per second.
 */
export function crashContent(uid: number): Buffer {
  const size = uid % 5 === 0 ? 1 << 20 : 512 + (uid % 17) * 64;
  const buf = Buffer.allocUnsafe(size);
  for (let j = 0; j < size; j++) buf[j] = (uid * 31 + j * 7) & 0xff;
  return buf;
}

function main(dbPath: string, opsPath: string): void {
  // The production open path (src/main.ts): WAL, catalog, INBOX.
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
  const ops = openSync(opsPath, 'a');

  for (let i = 1; ; i++) {
    const uid = inbox.append(crashContent(i));
    writeSync(ops, `a ${uid}\n`);
    if (i % 3 === 0) {
      inbox.storeFlags(uid, 'add', ['\\Seen', `$crash${uid}`]);
      writeSync(ops, `f ${uid}\n`);
    }
    if (i % 5 === 0 && i >= 3) {
      inbox.expunge(i - 2);
      writeSync(ops, `x ${i - 2}\n`);
    }
  }
}

if (process.argv[2] === 'run') {
  main(process.argv[3]!, process.argv[4]!);
}
