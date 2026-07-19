/**
 * Stress benchmark — push bulk operations and big mailboxes to find the NEXT bottleneck
 * after the per-command read tax was fixed (docs/PERFORMANCE.md).
 *
 * Drives the real ImapServer over the wire on a preloaded on-disk mailbox, and times the
 * whole-mailbox WRITE commands a client actually issues: STORE 1:* (mark all read/flagged),
 * COPY 1:* (archive a folder), SEARCH BODY (full-text), EXPUNGE (empty the trash). Each of
 * these is one IMAP command, so its wall time is exactly how long the single-threaded server
 * is frozen for every other user while it runs.
 *
 *   node --expose-gc perf/stress.bench.ts [mailboxSize] [msgBytes]
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { scratchDir, makeMessage, pad } from './lib.ts';

const mailboxSize = parseInt(process.argv[2] ?? '20000', 10);
const msgBytes = parseInt(process.argv[3] ?? '4096', 10);
const now = (): number => Number(process.hrtime.bigint()) / 1e6;

function client(port: number): { sock: net.Socket; connected: Promise<void>; run: (cmd: string, tag: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  const waiters: Array<{ re: RegExp; resolve: (s: string) => void; from: number }> = [];
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.re.test(buf.slice(waiters[i]!.from))) {
        waiters[i]!.resolve(buf.slice(waiters[i]!.from));
        waiters.splice(i, 1);
      }
    }
  });
  sock.on('error', () => {});
  return {
    sock,
    connected: new Promise((r) => sock.once('connect', () => r())),
    run: (cmd, tag) =>
      new Promise((resolve) => {
        const from = buf.length;
        sock.write(Buffer.from(cmd, 'latin1'));
        const re = new RegExp(`^${tag} (OK|NO|BAD)`, 'm');
        waiters.push({ re, resolve, from });
      }),
  };
}

async function main(): Promise<void> {
  const dir = scratchDir('stress');
  const dbPath = `${dir.path}/mail.db`;
  const db: DatabaseSync = openMailDb(dbPath);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  cat.create('Archive');
  process.stderr.write(`Preloading ${mailboxSize} messages (${((mailboxSize * msgBytes) / 1048576).toFixed(0)} MB)...\n`);
  const needle = Buffer.from('NEEDLE-marker-token', 'latin1');
  for (let i = 0; i < mailboxSize; i++) {
    // Every 500th message carries the needle, so SEARCH BODY has real (sparse) hits.
    const m = makeMessage(i, msgBytes);
    if (i % 500 === 0) needle.copy(m, m.length - needle.length);
    inbox.append(m, []);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const imap = await ImapServer.start(cat, { authenticate: () => true });
  const c = client(imap.port);
  await c.connected;
  await c.run('a LOGIN u p\r\n', 'a');
  await c.run('b SELECT INBOX\r\n', 'b');

  const time = async (label: string, cmd: string, tag: string): Promise<{ label: string; ms: number; perS: number }> => {
    const t0 = now();
    const resp = await c.run(cmd, tag);
    const ms = now() - t0;
    if (!new RegExp(`^${tag} OK`, 'm').test(resp)) process.stderr.write(`  (${label} did not return OK: ${resp.slice(0, 80)})\n`);
    return { label, ms, perS: mailboxSize / (ms / 1000) };
  };

  const rows: Array<{ label: string; ms: number; perS: number }> = [];
  // Bulk flag on the whole mailbox — one IMAP command, N storeFlags calls under the hood.
  rows.push(await time('STORE 1:* +FLAGS (\\Flagged)', 'c STORE 1:* +FLAGS.SILENT (\\Flagged)\r\n', 'c'));
  // Full-body text search — must stream every body once.
  rows.push(await time('SEARCH BODY "NEEDLE"', 'd SEARCH BODY "NEEDLE-marker-token"\r\n', 'd'));
  // Archive the whole folder — one COPY command, N appends to the target.
  rows.push(await time('COPY 1:* Archive', 'e COPY 1:* Archive\r\n', 'e'));
  // Flag everything deleted, then expunge it all — the "empty a big folder" path.
  rows.push(await time('STORE 1:* +FLAGS (\\Deleted)', 'f STORE 1:* +FLAGS.SILENT (\\Deleted)\r\n', 'f'));
  rows.push(await time('EXPUNGE (all)', 'g EXPUNGE\r\n', 'g'));

  c.sock.destroy();
  await imap.close();
  db.close();
  dir.cleanup();

  console.log(`\nBulk-command stress — ${mailboxSize}-message mailbox, ${msgBytes}-byte messages\n`);
  console.log([pad('command (one IMAP request)', 32, true), pad('wall ms', 10), pad('msgs/s', 10)].join(' '));
  console.log('-'.repeat(54));
  for (const r of rows) console.log([pad(r.label, 32, true), pad(r.ms.toFixed(0), 10), pad(Math.round(r.perS), 10)].join(' '));
  console.log(
    '\nEach row is ONE command; because the server is single-threaded and node:sqlite is synchronous,' +
      '\n"wall ms" is also how long every OTHER user and all inbound mail are frozen while it runs.\n',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
