/**
 * Mixed-load bug hunt — run inbound delivery, authenticated outbound submission, and IMAP
 * traffic against the REAL daemon at once, sustained, and watch for categories of failure the
 * single-stream benchmarks can't show:
 *
 *   - the outbound queue backing up unboundedly (submission accepts faster than relay drains
 *     under CPU contention → disk growth, no backpressure)
 *   - memory climbing over time (a leak — per-connection state, queue rows, notifier subs)
 *   - SQLITE_BUSY / lost updates when submission (enqueue), the relay loop (settle/reschedule),
 *     inbound delivery, and IMAP all touch SQLite concurrently
 *   - the bounce path under load (set --rejectRate>0: the sink 5xx-rejects, the relay bounces a
 *     DSN back to the local sender's INBOX, which IMAP is also reading)
 *   - crashes / hangs / error storms at the edge of what the machine sustains
 *
 *   node --expose-gc perf/mixed-load.bench.ts [seconds] [inConc] [outConc] [imapConc] [rejectRate]
 */

import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync } from 'node:crypto';
import { startServer, type MailServerConfig } from '../src/main.ts';
import { SmtpReceiver } from '../src/server/smtp-receiver.ts';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { TEST_CERT, TEST_KEY } from '../src/testing/tls-test-cert.ts';
import { scratchDir, makeMessage, rssMB, pad } from './lib.ts';

const seconds = parseInt(process.argv[2] ?? '20', 10);
const inConc = parseInt(process.argv[3] ?? '8', 10);
const outConc = parseInt(process.argv[4] ?? '8', 10);
const imapConc = parseInt(process.argv[5] ?? '8', 10);
const rejectRate = parseFloat(process.argv[6] ?? '0');
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const token = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');
const USERS = ['alice', 'bob'];

const stats = { inOk: 0, inErr: 0, outOk: 0, outErr: 0, imapOk: 0, imapErr: 0, busy: 0, bounces: 0 };

function reader(sock: NodeJS.ReadableStream): { wait: (needle: string, ms?: number) => Promise<void> } {
  let acc = '';
  sock.on('data', (d: Buffer) => (acc += d.toString('latin1')));
  return {
    wait: (needle, ms = 15000) =>
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
          reject(new Error(`timeout "${needle}": ${acc.slice(-60)}`));
        }, ms);
      }),
  };
}

const bodyFor = (from: string, to: string, i: number): string =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: mix ${i}\r\n\r\n` +
  makeMessage(i, 3072).subarray(400).toString('latin1').replace(/\r\n\./g, '\r\n..');

/** Inbound worker: deliver to local users on port 25 (no auth), reusing the connection. */
async function inboundWorker(port: number, deadline: number, id: number): Promise<void> {
  let i = 0;
  while (now() < deadline) {
    try {
      const s = net.connect(port, '127.0.0.1');
      s.on('error', () => {});
      const r = reader(s);
      await r.wait('ESMTP');
      s.write(Buffer.from('EHLO ext.example\r\n', 'latin1'));
      await r.wait('250 ');
      while (now() < deadline) {
        const to = `${USERS[i % USERS.length]}@sender.example`;
        s.write(Buffer.from(`MAIL FROM:<remote${id}@ext.example>\r\n`, 'latin1'));
        await r.wait('250 ');
        s.write(Buffer.from(`RCPT TO:<${to}>\r\n`, 'latin1'));
        await r.wait('250 ');
        s.write(Buffer.from('DATA\r\n', 'latin1'));
        await r.wait('354');
        s.write(Buffer.from(bodyFor(`remote${id}@ext.example`, to, i) + '\r\n.\r\n', 'latin1'));
        await r.wait('250 ');
        stats.inOk++;
        i++;
      }
      s.destroy();
    } catch (e) {
      stats.inErr++;
      if (/busy|locked/i.test(String(e))) stats.busy++;
      await delay(20);
    }
  }
}

/** Outbound worker: authenticated submission to REMOTE recipients on 587, over STARTTLS. */
async function outboundWorker(port: number, deadline: number, id: number): Promise<void> {
  let i = 0;
  while (now() < deadline) {
    try {
      const raw = net.connect(port, '127.0.0.1');
      raw.on('error', () => {});
      const rr = reader(raw);
      await rr.wait('ESMTP');
      raw.write(Buffer.from('EHLO perf\r\n', 'latin1'));
      await rr.wait('250 STARTTLS');
      raw.write(Buffer.from('STARTTLS\r\n', 'latin1'));
      await rr.wait('Ready to start TLS');
      const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
      secure.on('error', () => {});
      await new Promise<void>((res, rej) => {
        secure.once('secureConnect', () => res());
        secure.once('error', rej);
      });
      const sr = reader(secure);
      const user = USERS[id % USERS.length]!;
      secure.write(Buffer.from('EHLO perf\r\n', 'latin1'));
      await sr.wait('250 AUTH PLAIN');
      secure.write(Buffer.from('AUTH PLAIN ' + token(user, 'pw-' + user) + '\r\n', 'latin1'));
      await sr.wait('235');
      while (now() < deadline) {
        secure.write(Buffer.from(`MAIL FROM:<${user}@sender.example>\r\n`, 'latin1'));
        await sr.wait('2.1.0 Ok');
        secure.write(Buffer.from(`RCPT TO:<dest${i}@remote.example>\r\n`, 'latin1'));
        await sr.wait('2.1.5 Ok');
        secure.write(Buffer.from('DATA\r\n', 'latin1'));
        await sr.wait('354');
        secure.write(Buffer.from(bodyFor(`${user}@sender.example`, `dest${i}@remote.example`, i) + '\r\n.\r\n', 'latin1'));
        await sr.wait('message stored');
        stats.outOk++;
        i++;
      }
      secure.end();
    } catch (e) {
      stats.outErr++;
      if (/busy|locked/i.test(String(e))) stats.busy++;
      await delay(20);
    }
  }
}

/** IMAP worker: IMAPS LOGIN/SELECT then a loop of FETCH (metadata + one body) and STORE. */
async function imapWorker(port: number, deadline: number, id: number): Promise<void> {
  while (now() < deadline) {
    try {
      const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
      sock.on('error', () => {});
      await new Promise<void>((res, rej) => {
        sock.once('secureConnect', () => res());
        sock.once('error', rej);
      });
      const r = reader(sock);
      const user = USERS[id % USERS.length]!;
      await r.wait('* OK');
      sock.write(Buffer.from(`a LOGIN ${user} pw-${user}\r\n`, 'latin1'));
      await r.wait('a OK');
      sock.write(Buffer.from('b SELECT INBOX\r\n', 'latin1'));
      await r.wait('b OK');
      let n = 0;
      while (now() < deadline) {
        sock.write(Buffer.from(`c${n} FETCH 1:* (FLAGS UID)\r\n`, 'latin1'));
        await r.wait(`c${n} OK`);
        sock.write(Buffer.from(`d${n} STORE 1 +FLAGS.SILENT (\\Seen)\r\n`, 'latin1'));
        await r.wait(`d${n} `);
        stats.imapOk++;
        n++;
      }
      sock.destroy();
    } catch (e) {
      stats.imapErr++;
      if (/busy|locked/i.test(String(e))) stats.busy++;
      await delay(20);
    }
  }
}

async function main(): Promise<void> {
  const dir = scratchDir('mixed');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dkimPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  let sinkGot = 0;
  const sink = await SmtpReceiver.start(
    () => {
      sinkGot++;
    },
    {
      // Reject a fraction of recipients with a permanent 5xx so the relay generates DSN bounces
      // back to the local sender — exercising the bounce path under load.
      acceptRecipient: (addr) => rejectRate <= 0 || (hashStr(addr) % 1000) / 1000 >= rejectRate,
    },
  );

  // Seed each user's INBOX so IMAP FETCH has data from the start.
  for (const u of USERS) {
    const db = openMailDb(`${dir.path}/mail-${u}.db`);
    const inbox = SqliteCatalog.open(db).get('INBOX')!;
    for (let i = 0; i < 200; i++) inbox.append(makeMessage(i, 3072), i % 2 ? ['\\Seen'] : []);
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
    // Fast, deterministic auth resolvers so inbound measures mail PROCESSING, not DNS latency to
    // the test's fake domains (dkim=none, spf=none → dmarc=none → delivered to INBOX).
    dkimKeyResolver: async () => null,
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
    relayIntervalMs: 500,
    onEvent: (line) => {
      if (/bounce/i.test(line)) stats.bounces++;
    },
  };
  const server = await startServer(cfg);
  process.stderr.write(`daemon up. inbound:${server.inbound.port} submission:${server.submission.port} imaps:${server.imap.port} sink:${sink.port}\n`);
  process.stderr.write(`running ${seconds}s: ${inConc} inbound + ${outConc} outbound + ${imapConc} imap workers, rejectRate=${rejectRate}\n`);

  const rss0 = rssMB();
  const deadline = now() + seconds * 1000;
  const samples: Array<{ t: number; q: number; rss: number }> = [];
  const sampler = setInterval(() => {
    samples.push({ t: (now() - (deadline - seconds * 1000)) / 1000, q: server.queue.size, rss: rssMB() - rss0 });
  }, 1000);

  await Promise.all([
    ...Array.from({ length: inConc }, (_, i) => inboundWorker(server.inbound.port, deadline, i)),
    ...Array.from({ length: outConc }, (_, i) => outboundWorker(server.submission.port, deadline, i)),
    ...Array.from({ length: imapConc }, (_, i) => imapWorker(server.imap.port, deadline, i)),
  ]);
  clearInterval(sampler);

  // Let the queue finish draining what was accepted.
  const drainStart = now();
  while (server.queue.size > 0 && now() - drainStart < 30000) await delay(250);
  const finalQueue = server.queue.size;
  const rssEnd = rssMB() - rss0;
  const dead = server.queue.listDeadLetters().length;

  await server.close();
  await sink.close();
  dir.cleanup();

  const peakQ = samples.reduce((m, s) => Math.max(m, s.q), 0);
  const peakRss = samples.reduce((m, s) => Math.max(m, s.rss), 0);
  console.log(`\nMixed load — ${seconds}s, ${inConc} in / ${outConc} out / ${imapConc} imap, rejectRate ${rejectRate}\n`);
  console.log([pad('stream', 22, true), pad('completed', 12), pad('rate/s', 10), pad('errors', 10)].join(' '));
  console.log('-'.repeat(56));
  console.log([pad('inbound delivered', 22, true), pad(stats.inOk, 12), pad(Math.round(stats.inOk / seconds), 10), pad(stats.inErr, 10)].join(' '));
  console.log([pad('outbound accepted', 22, true), pad(stats.outOk, 12), pad(Math.round(stats.outOk / seconds), 10), pad(stats.outErr, 10)].join(' '));
  console.log([pad('imap fetch+store ops', 22, true), pad(stats.imapOk, 12), pad(Math.round(stats.imapOk / seconds), 10), pad(stats.imapErr, 10)].join(' '));
  console.log('');
  console.log([pad('relayed to sink', 22, true), pad(sinkGot, 12)].join(' '));
  console.log([pad('peak / final queue', 22, true), pad(`${peakQ} / ${finalQueue}`, 12)].join(' '));
  console.log([pad('dead-letters', 22, true), pad(dead, 12)].join(' '));
  console.log([pad('bounce events', 22, true), pad(stats.bounces, 12)].join(' '));
  console.log([pad('SQLITE_BUSY/locked', 22, true), pad(stats.busy, 12)].join(' '));
  console.log([pad('RSS Δ peak / end MB', 22, true), pad(`${peakRss.toFixed(0)} / ${rssEnd.toFixed(0)}`, 12)].join(' '));
  console.log('\nqueue depth over time (per second):');
  console.log('  ' + samples.map((s) => s.q).join(' '));
  console.log(
    `\nWatch for: queue depth CLIMBING without bound (relay can't keep up → disk risk); RSS end >> start` +
      `\n(leak); any SQLITE_BUSY (write contention the busy_timeout didn't absorb); errors that aren't zero.\n`,
  );
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
