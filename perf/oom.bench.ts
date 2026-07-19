/**
 * OOM hunt — read-side slowloris. The server is synchronous, so it frames one FETCH
 * response at a time; concurrent FAST fetches don't multiply its memory. The real vector
 * is a client that ASKS for a big body then stops reading: the server frames it and
 * `write()`s it, and Node buffers the whole thing in the connection's write queue with no
 * bound. K such clients each pin bodySize bytes in the server. This ramps K until the
 * process dies or a ceiling is found.
 *
 *   node --expose-gc perf/oom.bench.ts [msgMB] [step] [maxClients]
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { scratchDir, makeMessage, rssMB, pad } from './lib.ts';

const msgMB = parseInt(process.argv[2] ?? '20', 10);
const step = parseInt(process.argv[3] ?? '8', 10);
const maxClients = parseInt(process.argv[4] ?? '200', 10);
const msgBytes = msgMB * 1024 * 1024;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = scratchDir('oom');
  const db: DatabaseSync = openMailDb(`${dir.path}/mail.db`);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  // A handful of big messages is enough — clients re-fetch them; the memory is in the
  // server's write buffers, not the mailbox.
  for (let i = 0; i < 8; i++) inbox.append(makeMessage(i, msgBytes), []);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const imap = await ImapServer.start(cat, { authenticate: () => true });
  const base = rssMB();
  process.stderr.write(`Base RSS ${base.toFixed(0)} MB. Each stalled client should pin ~${msgMB} MB of server write buffer.\n`);

  const sockets: net.Socket[] = [];
  /** One slow-reading client: LOGIN, SELECT, request a big body, then STOP reading. */
  const stalledFetch = async (): Promise<void> => {
    const sock = net.connect(imap.port, '127.0.0.1');
    sockets.push(sock);
    let buf = '';
    let reading = true;
    sock.on('data', (d) => {
      if (reading) buf += d.toString('latin1');
    });
    sock.on('error', () => {});
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const step2 = (cmd: string, tag: string): Promise<void> =>
      new Promise((res) => {
        const from = buf.length;
        sock.write(Buffer.from(cmd, 'latin1'));
        const iv = setInterval(() => {
          if (new RegExp(`^${tag} OK`, 'm').test(buf.slice(from))) {
            clearInterval(iv);
            res();
          }
        }, 5);
      });
    await step2('a LOGIN u p\r\n', 'a');
    await step2('b SELECT INBOX\r\n', 'b');
    // Ask for a big body, then go silent: never read the response. The server frames it and
    // buffers the whole thing because we stop consuming.
    reading = false;
    sock.pause();
    sock.write(Buffer.from(`c FETCH 1 (BODY.PEEK[])\r\n`, 'latin1'));
  };

  const rows: Array<{ clients: number; rssMB: number }> = [];
  let clients = 0;
  let died = false;
  try {
    while (clients < maxClients) {
      for (let i = 0; i < step; i++) await stalledFetch();
      clients += step;
      await delay(400); // let the server frame + buffer the responses
      const rss = rssMB();
      rows.push({ clients, rssMB: rss - base });
      process.stderr.write(`  ${clients} stalled clients -> RSS +${(rss - base).toFixed(0)} MB\n`);
    }
  } catch (e) {
    died = true;
    process.stderr.write(`  died at ~${clients} clients: ${String(e).slice(0, 60)}\n`);
  }

  for (const s of sockets) s.destroy();
  await imap.close().catch(() => {});
  db.close();
  dir.cleanup();

  console.log(`\nOOM hunt — ${msgMB} MB bodies, +${step} stalled (non-reading) clients per step\n`);
  console.log([pad('stalled clients', 16), pad('server RSS Δ MB', 16), pad('MB/client', 12)].join(' '));
  console.log('-'.repeat(46));
  for (const r of rows) console.log([pad(r.clients, 16), pad(r.rssMB.toFixed(0), 16), pad((r.rssMB / r.clients).toFixed(1), 12)].join(' '));
  const peak = rows.reduce((m, r) => Math.max(m, r.rssMB), 0);
  const perClient = rows.length > 0 ? peak / rows[rows.length - 1]!.clients : 0;
  const bounded = !died && perClient < msgMB / 2; // memory did NOT grow ~msgMB per client
  console.log(
    `\n${died ? '*** process OOM-killed ***' : 'survived to the cap'}. Peak RSS Δ ${peak.toFixed(0)} MB over ${clients} clients` +
      ` (${perClient.toFixed(1)} MB/client).` +
      (bounded
        ? `\nRSS stayed bounded regardless of client count — the slow-consumer write-backlog guard is shedding stalled readers.\n`
        : `\nRSS grew ~${msgMB} MB per client with no bound — a few authenticated slow-readers can exhaust memory (no write-backlog cap).\n`),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
