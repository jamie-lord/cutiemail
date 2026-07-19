/**
 * Storage-scaling benchmark — how the SQLite mailbox behaves as a real mailbox grows.
 *
 * Drives the PRODUCTION SqliteMailbox against real on-disk WAL databases (not
 * :memory:), because the thing under test is exactly what the IMAP server does on
 * every command: `selected.messages`. That getter (src/store/sqlite-mailbox.ts)
 * runs `SELECT ... raw ... FROM message` for the WHOLE mailbox, copies every BLOB
 * into a fresh Buffer, and runs one extra flag query PER message. The IMAP server
 * reads that getter to answer even `FETCH 1 (FLAGS)` — so the cost of touching one
 * message is the cost of materialising the entire mailbox.
 *
 * This measures that tax across mailbox sizes, plus append throughput and the
 * O(n) `sequenceNumber` COUNT. Run with:
 *   node --expose-gc perf/storage-scaling.bench.ts [sizes] [msgBytes]
 * e.g. node --expose-gc perf/storage-scaling.bench.ts 1000,10000,50000 4096
 */

import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { timed, rssMB, scratchDir, fileSizeMB, makeMessage, pad } from './lib.ts';

const sizes = (process.argv[2] ?? '1000,10000,50000').split(',').map((s) => parseInt(s, 10));
const msgBytes = parseInt(process.argv[3] ?? '4096', 10);

interface Row {
  n: number;
  dbMB: number;
  appendMsgPerS: number;
  loadMs: number; // one full `.messages` access — the per-IMAP-command tax
  loadMB: number; // bytes materialised into JS heap by that access
  rssAfterMB: number;
  fetch1Ms: number; // cost to read a SINGLE message's flags (== full load today)
  seqNoMs: number; // sequenceNumber() of a mid mailbox UID — O(n) COUNT
  statusMs: number; // STATUS (MESSAGES UNSEEN SIZE) — also loads everything today
}

function benchOne(n: number): Row {
  const dir = scratchDir(`store-${n}`);
  const dbPath = `${dir.path}/mail.db`;
  const db: DatabaseSync = openMailDb(dbPath);
  try {
    const cat = SqliteCatalog.open(db);
    const inbox = cat.get('INBOX')!;

    // --- append throughput ---
    const msgs: Buffer[] = [];
    for (let i = 0; i < n; i++) msgs.push(makeMessage(i, msgBytes));
    const appended = timed(() => {
      for (let i = 0; i < n; i++) inbox.append(msgs[i]!, i % 3 === 0 ? ['\\Seen'] : []);
    });
    const appendMsgPerS = n / (appended.ms / 1000);

    // Force a checkpoint so the file size is honest, then re-open cold to defeat
    // any page-cache warmth from the append loop.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const cold: DatabaseSync = openMailDb(dbPath);
    const coldCat = SqliteCatalog.open(cold);
    const coldInbox = coldCat.get('INBOX')!;
    const dbMB = fileSizeMB(dbPath);

    // --- the per-command tax: one full `.messages` materialisation ---
    const rssBefore = rssMB();
    let materialised = 0;
    const load = timed(() => {
      const all = coldInbox.messages;
      for (const m of all) materialised += m.raw.length; // touch every byte reference
      return all.length;
    });
    const rssAfterMB = rssMB();

    // --- what the server pays to answer FETCH 1 (FLAGS): same full load ---
    const fetch1 = timed(() => {
      const all = coldInbox.messages;
      return all[0]?.flags.size ?? 0; // the server indexes [0] after loading ALL
    });

    // --- sequenceNumber of a mid UID: O(n) COUNT(*) WHERE uid <= ? ---
    const midUid = Math.max(1, Math.floor(n / 2));
    const seq = timed(() => coldInbox.sequenceNumber(midUid));

    // --- STATUS (MESSAGES UNSEEN SIZE): the server maps/filters `.messages` ---
    const status = timed(() => {
      const all = coldInbox.messages;
      const unseen = all.filter((m) => !m.flags.has('\\Seen')).length;
      const bytes = all.reduce((a, m) => a + m.raw.length, 0);
      return unseen + bytes;
    });

    cold.close();
    return {
      n,
      dbMB,
      appendMsgPerS,
      loadMs: load.ms,
      loadMB: materialised / 1048576,
      rssAfterMB: rssAfterMB - rssBefore,
      fetch1Ms: fetch1.ms,
      seqNoMs: seq.ms,
      statusMs: status.ms,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    dir.cleanup();
  }
}

console.log(`\nStorage scaling — ${msgBytes}-byte messages, WAL on disk, cold-read after checkpoint\n`);
const H = ['msgs', 'dbMB', 'append/s', 'load ms', 'loadMB', 'rssΔMB', 'FETCH1 ms', 'seqNo ms', 'STATUS ms'];
const W = [8, 8, 10, 9, 8, 8, 10, 9, 10];
console.log(H.map((h, i) => pad(h, W[i]!)).join(' '));
console.log(W.map((w) => '-'.repeat(w)).join(' '));
for (const n of sizes) {
  const r = benchOne(n);
  const cells = [
    r.n,
    r.dbMB.toFixed(1),
    Math.round(r.appendMsgPerS),
    r.loadMs.toFixed(1),
    r.loadMB.toFixed(1),
    r.rssAfterMB.toFixed(1),
    r.fetch1Ms.toFixed(1),
    r.seqNoMs.toFixed(2),
    r.statusMs.toFixed(1),
  ];
  console.log(cells.map((c, i) => pad(c, W[i]!)).join(' '));
}
console.log(
  '\nRead: "FETCH1 ms" is the wall time to answer FETCH 1 (FLAGS) — one message — and it tracks' +
    '\n"load ms" because the server materialises the whole mailbox first. "loadMB" is heap churn per command.\n',
);
