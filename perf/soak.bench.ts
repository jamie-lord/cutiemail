/**
 * Soak — sustained mixed load under high connection CHURN, to surface SLOW leaks that a 20 s burst
 * can't. The design point is churn, not throughput: thousands of short-lived connections that
 * connect, do a little work (some IDLE then vanish abruptly — the classic leak trigger), and
 * disconnect. A per-connection leak of even a few KB, or one leaked handle/subscription, becomes
 * obvious over tens of thousands of connections.
 *
 * Instruments over time (GC forced before each memory sample, so the trend is LIVE memory, not GC
 * lag): rss/heapUsed/external/arrayBuffers, active handles, open fds (Linux), event-loop lag, each
 * server's live connection count, and the queue + dead-letter depth. Reports a linear-fit slope per
 * signal over the steady-state window — a leak is a significant positive slope; flat is clean.
 *
 *   node --expose-gc perf/soak.bench.ts [seconds] [imapSlots] [inboundSlots] [outboundSlots]
 */

import net from 'node:net';
import tls from 'node:tls';
import { readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { startServer, type MailServerConfig } from '../src/main.ts';
import { SmtpReceiver } from '../src/server/smtp-receiver.ts';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { TEST_CERT, TEST_KEY } from '../src/testing/tls-test-cert.ts';
import { scratchDir, makeMessage, pad } from './lib.ts';

const seconds = parseInt(process.argv[2] ?? '60', 10);
const imapSlots = parseInt(process.argv[3] ?? '6', 10);
const inboundSlots = parseInt(process.argv[4] ?? '6', 10);
const outboundSlots = parseInt(process.argv[5] ?? '3', 10);
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const token = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');
const MB = 1048576;
const USERS = ['alice', 'bob'];
const counts = { imap: 0, inbound: 0, outbound: 0, errs: 0 };

function fdCount(): number {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}
function activeHandles(): number {
  const f = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  return typeof f === 'function' ? f.call(process).length : -1;
}

function reader(sock: NodeJS.ReadableStream): (needle: string, ms?: number) => Promise<void> {
  let acc = '';
  sock.on('data', (d: Buffer) => (acc += d.toString('latin1')));
  return (needle, ms = 8000) =>
    new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (acc.includes(needle)) {
          clearInterval(t);
          acc = '';
          resolve();
        }
      }, 3);
      setTimeout(() => {
        clearInterval(t);
        reject(new Error(`timeout "${needle}"`));
      }, ms);
    });
}

/** One short-lived inbound delivery, then disconnect. */
async function inboundOnce(port: number, i: number): Promise<void> {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {});
  const r = reader(s);
  await r('ESMTP');
  s.write(Buffer.from('EHLO ext.example\r\n', 'latin1'));
  await r('250 ');
  s.write(Buffer.from(`MAIL FROM:<r${i}@ext.example>\r\n`, 'latin1'));
  await r('250 ');
  s.write(Buffer.from(`RCPT TO:<${USERS[i % 2]}@sender.example>\r\n`, 'latin1'));
  await r('250 ');
  s.write(Buffer.from('DATA\r\n', 'latin1'));
  await r('354');
  s.write(Buffer.from(`From: r@ext.example\r\nSubject: s${i}\r\n\r\nbody ${i}\r\n.\r\n`, 'latin1'));
  await r('250 ');
  s.destroy(); // abrupt — exercise the close path, not a graceful QUIT
}

/** One short-lived authenticated submission to a remote recipient, then disconnect. */
async function outboundOnce(port: number, i: number): Promise<void> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const rr = reader(raw);
  await rr('ESMTP');
  raw.write(Buffer.from('EHLO perf\r\n', 'latin1'));
  await rr('250 STARTTLS');
  raw.write(Buffer.from('STARTTLS\r\n', 'latin1'));
  await rr('TLS');
  const sec = tls.connect({ socket: raw, rejectUnauthorized: false });
  sec.on('error', () => {});
  await new Promise<void>((res, rej) => {
    sec.once('secureConnect', () => res());
    sec.once('error', rej);
  });
  const sr = reader(sec);
  const u = USERS[i % 2]!;
  sec.write(Buffer.from('EHLO perf\r\n', 'latin1'));
  await sr('250 AUTH PLAIN');
  sec.write(Buffer.from('AUTH PLAIN ' + token(u, 'pw-' + u) + '\r\n', 'latin1'));
  await sr('235');
  sec.write(Buffer.from(`MAIL FROM:<${u}@sender.example>\r\n`, 'latin1'));
  await sr('2.1.0 Ok');
  sec.write(Buffer.from(`RCPT TO:<d${i}@remote.example>\r\n`, 'latin1'));
  await sr('2.1.5 Ok');
  sec.write(Buffer.from('DATA\r\n', 'latin1'));
  await sr('354');
  sec.write(Buffer.from(`From: ${u}@sender.example\r\nSubject: o${i}\r\n\r\nbody\r\n.\r\n`, 'latin1'));
  await sr('message stored');
  sec.destroy();
}

/** One short-lived IMAPS session; every 4th one IDLEs then vanishes abruptly (subscription-leak bait). */
async function imapOnce(port: number, i: number): Promise<void> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  sock.on('error', () => {});
  await new Promise<void>((res, rej) => {
    sock.once('secureConnect', () => res());
    sock.once('error', rej);
  });
  const r = reader(sock);
  const u = USERS[i % 2]!;
  await r('* OK');
  sock.write(Buffer.from(`a LOGIN ${u} pw-${u}\r\n`, 'latin1'));
  await r('a OK');
  sock.write(Buffer.from('b SELECT INBOX\r\n', 'latin1'));
  await r('b OK');
  sock.write(Buffer.from('c FETCH 1:* (FLAGS UID)\r\n', 'latin1'));
  await r('c OK');
  if (i % 4 === 0) {
    sock.write(Buffer.from('d IDLE\r\n', 'latin1'));
    await r('+ ');
    sock.destroy(); // abrupt close WHILE idling — must release the subscription
    return;
  }
  sock.write(Buffer.from('e STORE 1 +FLAGS.SILENT (\\Seen)\r\n', 'latin1'));
  await r('e ');
  sock.destroy();
}

function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? 0 : num / den; // units of y per unit of x (x in minutes)
}

async function main(): Promise<void> {
  const dir = scratchDir('soak');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dkimPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sink = await SmtpReceiver.start(() => {}, { acceptRecipient: () => true });
  for (const u of USERS) {
    const db = openMailDb(`${dir.path}/mail-${u}.db`);
    const inbox = SqliteCatalog.open(db).get('INBOX')!;
    for (let i = 0; i < 50; i++) inbox.append(makeMessage(i, 2048), i % 2 ? ['\\Seen'] : []);
    db.close();
  }
  const cfg: MailServerConfig = {
    dbPath: `${dir.path}/control.db`,
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'sender.example',
    accounts: USERS.map((u) => ({ user: u, pass: 'pw-' + u, mailDbPath: `${dir.path}/mail-${u}.db` })),
    tls: { key: TEST_KEY, cert: TEST_CERT },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: sink.port },
    dkim: { selector: 'perf', privateKeyPem: dkimPem },
    dkimKeyResolver: async () => null,
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
    relayIntervalMs: 500,
  };
  const server = await startServer(cfg);
  process.stderr.write(`daemon up; soaking ${seconds}s with churn (imap ${imapSlots}, inbound ${inboundSlots}, outbound ${outboundSlots})\n`);

  // Event-loop lag monitor.
  let lag = 0;
  let lastTick = now();
  const lagTimer = setInterval(() => {
    const drift = now() - lastTick - 200;
    if (drift > lag) lag = drift;
    lastTick = now();
  }, 200);

  const deadline = now() + seconds * 1000;
  const t0 = now();
  type S = { t: number; rss: number; heap: number; ext: number; ab: number; handles: number; fds: number; lag: number; conns: number; q: number; dl: number; ops: number };
  const samples: S[] = [];
  const sampler = setInterval(() => {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const m = process.memoryUsage();
    samples.push({
      t: (now() - t0) / 60000, // minutes
      rss: m.rss / MB,
      heap: m.heapUsed / MB,
      ext: m.external / MB,
      ab: m.arrayBuffers / MB,
      handles: activeHandles(),
      fds: fdCount(),
      lag: lag,
      conns: server.imap.connectionCount + server.submission.connectionCount + server.inbound.connectionCount,
      q: server.queue.size,
      dl: server.queue.listDeadLetters().length,
      ops: counts.imap + counts.inbound + counts.outbound,
    });
    lag = 0; // reset per interval
  }, 2000);

  // Churn pools: each slot loops one short connection at a time until the deadline.
  const pool = (n: number, once: (i: number) => Promise<void>, tag: keyof typeof counts): Promise<void>[] =>
    Array.from({ length: n }, () =>
      (async () => {
        let i = Math.floor(Math.random() * 1e6);
        while (now() < deadline) {
          try {
            await once(i++);
            counts[tag]++;
          } catch {
            counts.errs++;
            await delay(15);
          }
        }
      })(),
    );

  await Promise.all([
    ...pool(imapSlots, (i) => imapOnce(server.imap.port, i), 'imap'),
    ...pool(inboundSlots, (i) => inboundOnce(server.inbound.port, i), 'inbound'),
    ...pool(outboundSlots, (i) => outboundOnce(server.submission.port, i), 'outbound'),
  ]);
  clearInterval(sampler);
  clearInterval(lagTimer);

  // Let things settle, force GC, take a final "at rest" reading.
  await delay(1500);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const restRss = process.memoryUsage().rss / MB;
  const restConns = server.imap.connectionCount + server.submission.connectionCount + server.inbound.connectionCount;
  const restReserved = server.imap.appendReservedBytes;

  await server.close();
  await sink.close();
  dir.cleanup();

  // Steady-state window = drop the first 25% (warmup) before fitting slopes.
  const steady = samples.slice(Math.floor(samples.length * 0.25));
  const ts = steady.map((s) => s.t);
  const totalOps = counts.imap + counts.inbound + counts.outbound;
  const durMin = seconds / 60;

  console.log(`\nSoak — ${seconds}s, churn imap/inbound/outbound = ${imapSlots}/${inboundSlots}/${outboundSlots}\n`);
  console.log(`connections served: imap ${counts.imap}, inbound ${counts.inbound}, outbound ${counts.outbound}, errors ${counts.errs}`);
  console.log(`total ${totalOps} connections in ${durMin.toFixed(1)} min = ${Math.round(totalOps / seconds)}/s churn\n`);
  const first = steady[0]!;
  const last = steady[steady.length - 1]!;
  const row = (name: string, key: keyof S, unit: string): void => {
    const s = slope(ts, steady.map((x) => x[key]));
    console.log([pad(name, 16, true), pad(first[key].toFixed(1), 10), pad(last[key].toFixed(1), 10), pad(`${s >= 0 ? '+' : ''}${s.toFixed(2)} ${unit}`, 16, true)].join(' '));
  };
  console.log([pad('signal', 16, true), pad('start', 10), pad('end', 10), pad('slope (per min)', 16, true)].join(' '));
  console.log('-'.repeat(54));
  row('RSS MB', 'rss', 'MB/min');
  row('heapUsed MB', 'heap', 'MB/min');
  row('external MB', 'ext', 'MB/min');
  row('arrayBuffers MB', 'ab', 'MB/min');
  row('active handles', 'handles', '/min');
  row('open fds', 'fds', '/min');
  row('live conns', 'conns', '/min');
  row('queue depth', 'q', '/min');
  row('dead-letters', 'dl', '/min');
  console.log(`\npeak event-loop lag: ${Math.max(...samples.map((s) => s.lag)).toFixed(0)} ms`);
  console.log(`at rest after drain: RSS ${restRss.toFixed(0)} MB, live conns ${restConns}, APPEND reserved ${restReserved} B`);
  const rssSlope = slope(ts, steady.map((x) => x.rss));
  const perConnKB = (totalOps > 0 ? ((last.rss - first.rss) * 1024) / totalOps : 0).toFixed(3);
  console.log(
    `\nRSS slope ${rssSlope >= 0 ? '+' : ''}${rssSlope.toFixed(2)} MB/min over ${totalOps} churned connections (${perConnKB} KB/conn).` +
      `\nA leak shows as a sustained positive slope in RSS/heap/handles/fds and live-conns not returning to ~0.` +
      `\nFlat slopes + live conns → 0 at rest = no leak.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
