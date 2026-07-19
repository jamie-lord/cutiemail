/**
 * Large-message stress — the raw(uid) path still loads a whole body, so a big message (a
 * photo/PDF attachment) and, worse, MANY clients fetching big bodies at once are a memory
 * dimension the metadata fix did not touch. This measures the peak RSS of that.
 *
 *   node --expose-gc perf/large-messages.bench.ts [count] [msgKB] [concurrentFetchers]
 * e.g. 300 messages of 2 MB, fetched by 24 clients simultaneously.
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { scratchDir, makeMessage, rssMB, pad } from './lib.ts';

const count = parseInt(process.argv[2] ?? '300', 10);
const msgKB = parseInt(process.argv[3] ?? '2048', 10);
const fetchers = parseInt(process.argv[4] ?? '24', 10);
const msgBytes = msgKB * 1024;
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
        waiters.push({ re: new RegExp(`^${tag} (OK|NO|BAD)`, 'm'), resolve, from });
      }),
  };
}

async function main(): Promise<void> {
  const dir = scratchDir('large-msg');
  const db: DatabaseSync = openMailDb(`${dir.path}/mail.db`);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  process.stderr.write(`Preloading ${count} messages of ${msgKB} KB (${((count * msgBytes) / 1048576).toFixed(0)} MB)...\n`);
  for (let i = 0; i < count; i++) inbox.append(makeMessage(i, msgBytes), []);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const imap = await ImapServer.start(cat, { authenticate: () => true });
  const rssBase = rssMB();

  // One big-body fetch: latency + the cost of a single raw() + literal framing.
  const solo = client(imap.port);
  await solo.connected;
  await solo.run('a LOGIN u p\r\n', 'a');
  await solo.run('b SELECT INBOX\r\n', 'b');
  const t0 = now();
  await solo.run(`c FETCH 1 (BODY.PEEK[])\r\n`, 'c');
  const soloMs = now() - t0;
  const rssSolo = rssMB();
  solo.sock.destroy();

  // N clients each fetching a (different) big body at the SAME time — the memory spike.
  const conns = await Promise.all(
    Array.from({ length: fetchers }, async () => {
      const c = client(imap.port);
      await c.connected;
      await c.run('a LOGIN u p\r\n', 'a');
      await c.run('b SELECT INBOX\r\n', 'b');
      return c;
    }),
  );
  let peakRss = rssBase;
  const sampler = setInterval(() => {
    const r = process.memoryUsage().rss / 1048576;
    if (r > peakRss) peakRss = r;
  }, 5);
  const tc0 = now();
  await Promise.all(conns.map((c, i) => c.run(`f FETCH ${(i % count) + 1} (BODY.PEEK[])\r\n`, 'f')));
  const concurrentMs = now() - tc0;
  clearInterval(sampler);
  for (const c of conns) c.sock.destroy();

  await imap.close();
  db.close();
  dir.cleanup();

  console.log(`\nLarge-message fetch — ${count}×${msgKB}KB mailbox, ${fetchers} simultaneous body fetchers\n`);
  console.log([pad('metric', 40, true), pad('value', 12)].join(' '));
  console.log('-'.repeat(53));
  console.log([pad('single BODY[] fetch latency', 40, true), pad(`${soloMs.toFixed(0)} ms`, 12)].join(' '));
  console.log([pad('RSS after one fetch (over base)', 40, true), pad(`${(rssSolo - rssBase).toFixed(0)} MB`, 12)].join(' '));
  console.log([pad(`${fetchers} concurrent fetches — wall`, 40, true), pad(`${concurrentMs.toFixed(0)} ms`, 12)].join(' '));
  console.log([pad(`${fetchers} concurrent fetches — peak RSS Δ`, 40, true), pad(`${(peakRss - rssBase).toFixed(0)} MB`, 12)].join(' '));
  console.log(
    `\nEach ${msgKB}KB body is read into a Buffer (raw()), copied, then framed as a literal. With ${fetchers}` +
      `\nin flight that is the peak above — the number to watch against the box's RAM for big attachments.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
