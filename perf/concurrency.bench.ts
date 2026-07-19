/**
 * Concurrency / head-of-line-blocking benchmark — the "simultaneous in and out" case.
 *
 * node:sqlite is SYNCHRONOUS and the server is single-threaded, so any DB call blocks
 * the whole event loop for its duration. The storage benchmark showed one FETCH on a
 * 50k mailbox is a ~300 ms synchronous read. This measures what that does to everyone
 * ELSE on the server while it runs:
 *
 *   - IMAP greeting latency: open a fresh TCP connection, time connect -> "* OK" banner.
 *     This touches no mailbox; it is a pure proxy for "is the event loop responsive?".
 *   - SMTP delivery latency: a full inbound MAIL/RCPT/DATA -> 250. This is throughput "in".
 *
 * We sample both while K background IMAP clients hammer heavy FETCHes on one big mailbox
 * (throughput "out"). If the numbers stay flat, the server interleaves work fine. If they
 * balloon, a single heavy reader is freezing the whole server — every other user's
 * commands and every inbound delivery wait behind it.
 *
 *   node --expose-gc perf/concurrency.bench.ts [mailboxSize] [loaders] [seconds]
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { SmtpReceiver } from '../src/server/smtp-receiver.ts';
import { scratchDir, makeMessage, pad } from './lib.ts';

const mailboxSize = parseInt(process.argv[2] ?? '50000', 10);
const loaders = parseInt(process.argv[3] ?? '4', 10);
const seconds = parseInt(process.argv[4] ?? '5', 10);
const msgBytes = 4096;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Number(process.hrtime.bigint()) / 1e6;

/** Minimal line-oriented socket client. */
function client(port: number): {
  sock: net.Socket;
  connected: Promise<void>;
  until: (re: RegExp) => Promise<string>;
  send: (s: string) => void;
} {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  const waiters: Array<{ re: RegExp; resolve: (s: string) => void }> = [];
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.re.test(buf)) {
        waiters[i]!.resolve(buf);
        buf = '';
        waiters.splice(i, 1);
      }
    }
  });
  sock.on('error', () => {});
  return {
    sock,
    connected: new Promise((r) => sock.once('connect', () => r())),
    until: (re) => new Promise((resolve) => (re.test(buf) ? (resolve(buf), (buf = '')) : waiters.push({ re, resolve }))),
    send: (s) => sock.write(Buffer.from(s, 'latin1')),
  };
}

function stats(xs: number[]): { p50: number; p95: number; max: number; n: number } {
  if (xs.length === 0) return { p50: 0, p95: 0, max: 0, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]!, n: xs.length };
}

/** Time a fresh IMAP connection from connect() to the "* OK" greeting. */
async function greetingLatency(port: number): Promise<number> {
  const t0 = now();
  const c = client(port);
  await c.connected;
  await c.until(/\* OK/);
  const ms = now() - t0;
  c.sock.destroy();
  return ms;
}

/** Time a full inbound delivery: EHLO/MAIL/RCPT/DATA -> 250. */
async function deliveryLatency(port: number, i: number): Promise<number> {
  const t0 = now();
  const c = client(port);
  await c.connected;
  await c.until(/220 /);
  c.send('EHLO probe.example.com\r\n');
  await c.until(/250 /);
  c.send('MAIL FROM:<probe@example.com>\r\n');
  await c.until(/250 /);
  c.send('RCPT TO:<user@example.net>\r\n');
  await c.until(/250 /);
  c.send('DATA\r\n');
  await c.until(/354 /);
  const msg = makeMessage(1_000_000 + i, msgBytes).toString('latin1').replace(/\r\n\./g, '\r\n..');
  c.send(msg + '\r\n.\r\n');
  await c.until(/250 /);
  const ms = now() - t0;
  c.send('QUIT\r\n');
  c.sock.destroy();
  return ms;
}

/** A background loader: LOGIN, SELECT the big mailbox, then FETCH heavily until stopped. */
async function runLoader(port: number, stop: { done: boolean }): Promise<number> {
  const c = client(port);
  await c.connected;
  await c.until(/\* OK/);
  c.send('a LOGIN user pass\r\n');
  await c.until(/a OK/);
  c.send('b SELECT INBOX\r\n');
  await c.until(/b OK/);
  let count = 0;
  while (!stop.done) {
    const tag = `f${count}`;
    c.send(`${tag} FETCH 1 (FLAGS)\r\n`); // one message — but the server loads the whole mailbox
    await c.until(new RegExp(`${tag} OK`));
    count++;
  }
  c.sock.destroy();
  return count;
}

/** Sample a probe function repeatedly for `ms`, returning all latencies. */
async function sampleFor(ms: number, probe: () => Promise<number>, gap = 50): Promise<number[]> {
  const out: number[] = [];
  const end = now() + ms;
  let i = 0;
  while (now() < end) {
    out.push(await probe());
    i++;
    await delay(gap);
  }
  return out;
}

async function main(): Promise<void> {
  const dir = scratchDir('concurrency');
  const dbPath = `${dir.path}/mail.db`;
  const db: DatabaseSync = openMailDb(dbPath);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  process.stderr.write(`Preloading ${mailboxSize} messages (${((mailboxSize * msgBytes) / 1048576).toFixed(0)} MB)...\n`);
  for (let i = 0; i < mailboxSize; i++) inbox.append(makeMessage(i, msgBytes), i % 3 === 0 ? ['\\Seen'] : []);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const imap = await ImapServer.start(cat, { authenticate: () => true });
  const smtp = await SmtpReceiver.start(
    (m) => {
      inbox.append(m.data, [], Date.now());
    },
    { acceptRecipient: () => true },
  );

  // --- Phase 1: quiescent baseline ---
  process.stderr.write('Phase 1: quiescent baseline...\n');
  const baseGreet = await sampleFor(2000, () => greetingLatency(imap.port));
  let di = 0;
  const baseDeliver = await sampleFor(2000, () => deliveryLatency(smtp.port, di++));

  // --- Phase 2: under heavy FETCH load ---
  process.stderr.write(`Phase 2: ${loaders} background FETCH loaders for ${seconds}s...\n`);
  const stop = { done: false };
  const loaderPromises = Array.from({ length: loaders }, () => runLoader(imap.port, stop));
  await delay(300); // let loaders reach steady state
  const loadGreet = await sampleFor(seconds * 500, () => greetingLatency(imap.port));
  const loadDeliver = await sampleFor(seconds * 500, () => deliveryLatency(smtp.port, di++));
  stop.done = true;
  const fetchCounts = await Promise.all(loaderPromises);
  const totalFetches = fetchCounts.reduce((a, b) => a + b, 0);

  await imap.close();
  await smtp.close();
  db.close();
  dir.cleanup();

  // --- report ---
  const rows: Array<[string, ReturnType<typeof stats>]> = [
    ['IMAP greeting — idle', stats(baseGreet)],
    ['IMAP greeting — under load', stats(loadGreet)],
    ['SMTP delivery — idle', stats(baseDeliver)],
    ['SMTP delivery — under load', stats(loadDeliver)],
  ];
  console.log(`\nHead-of-line blocking — ${mailboxSize}-msg mailbox, ${loaders} heavy FETCH loaders\n`);
  console.log([pad('probe', 30, true), pad('p50 ms', 9), pad('p95 ms', 9), pad('max ms', 9), pad('samples', 8)].join(' '));
  console.log('-'.repeat(68));
  for (const [label, s] of rows) {
    console.log([pad(label, 30, true), pad(s.p50.toFixed(1), 9), pad(s.p95.toFixed(1), 9), pad(s.max.toFixed(1), 9), pad(s.n, 8)].join(' '));
  }
  const idleG = stats(baseGreet).p50 || 0.1;
  const loadG = stats(loadGreet).p50;
  console.log(
    `\nBackground FETCHes completed: ${totalFetches} (${(totalFetches / seconds).toFixed(0)}/s across ${loaders} clients).` +
      `\nGreeting p50 went ${idleG.toFixed(1)} -> ${loadG.toFixed(1)} ms (${(loadG / idleG).toFixed(0)}x) under load —` +
      `\nthat delay is pure event-loop starvation: the probe touches no mailbox, it just waits behind synchronous reads.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
