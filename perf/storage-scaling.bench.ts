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
  legacyMs: number; // OLD path: one full `.messages` access (loads every BLOB) — the per-command tax before the fix
  legacyMB: number; // bytes materialised into JS heap by that access
  indexMs: number; // NEW path: index() — metadata only, what a FETCH FLAGS / STATUS / SELECT now costs
  indexMB: number; // heap churned by index() (no BLOBs)
  raw1Ms: number; // NEW path: raw(uid) — fetch ONE body, what a BODY[] fetch of one message costs
  statusMs: number; // STATUS (MESSAGES UNSEEN SIZE) via index() — no BLOBs
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

    // --- OLD path: one full `.messages` materialisation (every BLOB copied) ---
    let materialised = 0;
    const legacy = timed(() => {
      const all = coldInbox.messages;
      for (const m of all) materialised += m.raw.length;
      return all.length;
    });

    // --- NEW path: index() — the metadata a FETCH FLAGS / STATUS / SELECT now reads ---
    let indexBytes = 0;
    const index = timed(() => {
      const all = coldInbox.index();
      for (const m of all) indexBytes += 24 + m.flags.size * 8; // rough per-row heap, no BLOBs
      return all.length;
    });

    // --- NEW path: raw(uid) — one body, what a BODY[] fetch of a single message costs ---
    const midUid = Math.max(1, Math.floor(n / 2));
    const raw1 = timed(() => coldInbox.raw(midUid)?.length ?? 0);

    // --- STATUS (MESSAGES UNSEEN SIZE) via index(): no BLOBs, size from metadata ---
    const status = timed(() => {
      const all = coldInbox.index();
      const unseen = all.filter((m) => !m.flags.has('\\Seen')).length;
      const bytes = all.reduce((a, m) => a + m.size, 0);
      return unseen + bytes;
    });

    cold.close();
    return {
      n,
      dbMB,
      appendMsgPerS,
      legacyMs: legacy.ms,
      legacyMB: materialised / 1048576,
      indexMs: index.ms,
      indexMB: indexBytes / 1048576,
      raw1Ms: raw1.ms,
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

console.log(`\nStorage scaling — ${msgBytes}-byte messages, WAL on disk, cold-read after checkpoint`);
console.log('OLD = the removed `.messages` getter; NEW = index() (metadata) + raw(uid) (one body).\n');
const H = ['msgs', 'dbMB', 'append/s', 'OLD ms', 'OLD MB', 'NEW idx ms', 'idx MB', 'raw1 ms', 'STATUS ms'];
const W = [8, 8, 10, 8, 8, 11, 8, 8, 10];
console.log(H.map((h, i) => pad(h, W[i]!)).join(' '));
console.log(W.map((w) => '-'.repeat(w)).join(' '));
for (const n of sizes) {
  const r = benchOne(n);
  const cells = [
    r.n,
    r.dbMB.toFixed(1),
    Math.round(r.appendMsgPerS),
    r.legacyMs.toFixed(1),
    r.legacyMB.toFixed(1),
    r.indexMs.toFixed(1),
    r.indexMB.toFixed(2),
    r.raw1Ms.toFixed(2),
    r.statusMs.toFixed(1),
  ];
  console.log(cells.map((c, i) => pad(c, W[i]!)).join(' '));
}
console.log(
  '\nRead: "OLD ms" is what answering FETCH 1 (FLAGS) cost before the fix (a full `.messages` load).' +
    '\n"NEW idx ms" is what it costs now (index(), metadata only); "raw1 ms" is a single BODY[] fetch.\n',
);
