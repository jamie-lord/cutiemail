/**
 * APPEND read-side OOM hunt — the mirror of the FETCH slow-consumer OOM, on the READ path.
 *
 * An IMAP APPEND uploads a message as a literal: `APPEND INBOX {N}` → the server buffers N octets
 * in that connection's receive buffer before it can store the message. A client that declares a big
 * literal then sends it slowly (or sends the octets but withholds the terminating CRLF) pins ~N
 * bytes in the server. Summed across connections — each needing only ONE such APPEND, so
 * MAX_CONNECTIONS doesn't help — this is an OOM, exactly like the FETCH write-buffer case.
 *
 * This ramps stalled-APPEND connections and reports server RSS: unbounded (bug) or plateauing at a
 * budget (fixed by refusing new APPENDs when too much literal data is already in flight).
 *
 *   node --expose-gc perf/append-oom.bench.ts [msgMB] [step] [maxClients]
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { scratchDir, rssMB, pad } from './lib.ts';

const msgMB = parseInt(process.argv[2] ?? '20', 10);
const step = parseInt(process.argv[3] ?? '8', 10);
const maxClients = parseInt(process.argv[4] ?? '256', 10);
const size = msgMB * 1024 * 1024;
const payload = Buffer.alloc(size, 0x41); // one shared buffer, so client-side memory stays flat
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = scratchDir('append-oom');
  const db: DatabaseSync = openMailDb(`${dir.path}/mail.db`);
  const cat = SqliteCatalog.open(db);
  cat.get('INBOX');
  const imap = await ImapServer.start(cat, { authenticate: () => true });
  const base = rssMB();
  process.stderr.write(`Base RSS ${base.toFixed(0)} MB. Each stalled APPEND should pin ~${msgMB} MB of receive buffer.\n`);

  const sockets: net.Socket[] = [];
  let refused = 0;
  /** LOGIN, start a big APPEND literal, send the octets but WITHHOLD the terminating CRLF, then go silent. */
  const stalledAppend = async (): Promise<void> => {
    const sock = net.connect(imap.port, '127.0.0.1');
    sockets.push(sock);
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('latin1')));
    sock.on('error', () => {});
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const until = async (re: RegExp): Promise<boolean> => {
      for (let i = 0; i < 400; i++) {
        if (re.test(buf)) return true;
        await delay(5);
      }
      return false;
    };
    await until(/\* OK/);
    buf = '';
    sock.write(Buffer.from('a LOGIN u p\r\n', 'latin1'));
    await until(/a OK/);
    buf = '';
    sock.write(Buffer.from(`b APPEND INBOX {${size}}\r\n`, 'latin1'));
    // Wait for the "+ Ready" go-ahead — or a "NO" refusal once the fix is in.
    await until(/\+ |b NO/);
    if (/b NO/.test(buf)) {
      refused++;
      sock.destroy();
      return;
    }
    // Send the octets but NOT the trailing CRLF, so the server holds them waiting for the end.
    sock.write(payload);
  };

  const rows: Array<{ clients: number; rssMB: number }> = [];
  let clients = 0;
  let died = false;
  try {
    while (clients < maxClients) {
      for (let i = 0; i < step; i++) await stalledAppend();
      clients += step;
      await delay(400);
      const rss = rssMB();
      rows.push({ clients, rssMB: rss - base });
      process.stderr.write(`  ${clients} stalled APPENDs -> RSS +${(rss - base).toFixed(0)} MB (refused ${refused})\n`);
    }
  } catch (e) {
    died = true;
    process.stderr.write(`  died at ~${clients}: ${String(e).slice(0, 60)}\n`);
  }

  for (const s of sockets) s.destroy();
  await imap.close().catch(() => {});
  db.close();
  dir.cleanup();

  const peak = rows.reduce((m, r) => Math.max(m, r.rssMB), 0);
  // Bounded = RSS stopped tracking client count: the last sample is no bigger than the mid sample
  // (a plateau), rather than still climbing ~msgMB per client.
  const mid = rows.length > 1 ? rows[Math.floor(rows.length / 2)]!.rssMB : 0;
  const last = rows.length > 0 ? rows[rows.length - 1]!.rssMB : 0;
  const bounded = !died && last <= mid * 1.25;
  console.log(`\nAPPEND read-side OOM — ${msgMB} MB literals, +${step} stalled uploaders/step\n`);
  console.log([pad('stalled APPENDs', 16), pad('server RSS Δ MB', 16), pad('MB/client', 12)].join(' '));
  console.log('-'.repeat(46));
  for (const r of rows) console.log([pad(r.clients, 16), pad(r.rssMB.toFixed(0), 16), pad((r.rssMB / r.clients).toFixed(1), 12)].join(' '));
  console.log(
    `\n${died ? '*** process OOM-killed ***' : 'survived to the cap'}. Peak RSS Δ ${peak.toFixed(0)} MB, ${refused} APPENDs refused.` +
      (bounded
        ? `\nRSS stayed bounded — the in-flight-APPEND budget is refusing new uploads under memory pressure.\n`
        : `\nRSS grew ~${msgMB} MB per client with no bound — many slow APPENDs can exhaust memory (no in-flight cap).\n`),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
