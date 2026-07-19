/**
 * Abuse harness — throw pathological input at a real IMAP server and see if it crashes,
 * hangs, leaks, or corrupts. Each attack is followed by a liveness probe (a normal command
 * on a fresh connection): if the server still answers, it survived; if the probe times out,
 * the attack wedged the event loop or the process.
 *
 *   node --expose-gc perf/abuse.bench.ts
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { ImapServer } from '../src/server/imap-server.ts';
import { scratchDir, makeMessage, rssMB, pad } from './lib.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function conn(port: number): { sock: net.Socket; run: (cmd: string, tag: string, ms?: number) => Promise<string>; raw: (b: Buffer) => void } {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.on('data', (d) => (buf += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (cmd: string, tag: string, ms = 4000): Promise<string> => {
    const from = buf.length;
    sock.write(Buffer.from(cmd, 'latin1'));
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(buf.slice(from))) return buf.slice(from);
      await delay(5);
    }
    throw new Error(`TIMEOUT on ${tag}`);
  };
  return { sock, run, raw: (b) => sock.write(b) };
}

/** Liveness: a brand-new connection must still get its greeting and answer NOOP quickly. */
async function alive(port: number): Promise<boolean> {
  try {
    const c = conn(port);
    await new Promise<void>((r, j) => {
      c.sock.once('connect', () => r());
      c.sock.once('error', j);
    });
    await c.run('z NOOP\r\n', 'z', 3000);
    c.sock.destroy();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dir = scratchDir('abuse');
  const db: DatabaseSync = openMailDb(`${dir.path}/mail.db`);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  for (let i = 0; i < 100; i++) inbox.append(makeMessage(i, 2048), i % 2 ? ['\\Seen'] : []);
  const imap = await ImapServer.start(cat, { authenticate: () => true });

  const results: Array<{ attack: string; survived: boolean; note: string }> = [];
  const check = async (attack: string, fn: () => Promise<string>): Promise<void> => {
    let note = '';
    try {
      const r = await fn();
      note = r.trim().split('\n').pop()?.slice(0, 48) ?? '';
    } catch (e) {
      note = String(e).slice(0, 48);
    }
    const survived = await alive(imap.port);
    results.push({ attack, survived, note });
  };

  const login = async (): Promise<ReturnType<typeof conn>> => {
    const c = conn(imap.port);
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a LOGIN u p\r\n', 'a');
    await c.run('b SELECT INBOX\r\n', 'b');
    return c;
  };

  // 1. Command line right at / over the 64 KB cap: a giant explicit sequence set.
  await check('64KB explicit sequence set FETCH', async () => {
    const c = await login();
    const huge = Array.from({ length: 12000 }, (_, i) => i + 1).join(','); // ~60KB
    const r = await c.run(`c FETCH ${huge} (UID)\r\n`, 'c', 8000);
    c.sock.destroy();
    return r;
  });

  // 2. Over-cap command line (>64KB) — must be rejected + connection closed, not buffered forever.
  await check('over-64KB command line', async () => {
    const c = await login();
    const over = 'x'.repeat(70000);
    const r = await c.run(`d SEARCH SUBJECT ${over}\r\n`, 'd', 6000).catch((e) => String(e));
    c.sock.destroy();
    return r;
  });

  // 3. FETCH with astronomically large numbers (near uint32/JS max) — no overflow/enumeration.
  await check('FETCH huge numeric range', async () => {
    const c = await login();
    const r = await c.run('e FETCH 1:4294967295 (UID)\r\n', 'e', 8000);
    c.sock.destroy();
    return r;
  });
  await check('STORE huge explicit numbers', async () => {
    const c = await login();
    const r = await c.run('f STORE 999999999,888888888,1:5 +FLAGS (\\Flagged)\r\n', 'f', 6000);
    c.sock.destroy();
    return r;
  });

  // 4. APPEND that declares a big literal then never sends it — does the connection/parse hang
  //    or leak? (The server should just wait on THAT connection; others stay live.)
  await check('APPEND literal declared, never sent', async () => {
    const c = await login();
    c.raw(Buffer.from('g APPEND INBOX {5000000}\r\n', 'latin1'));
    await delay(300); // send nothing more
    c.sock.destroy();
    return 'left dangling';
  });

  // 5. APPEND over the 25 MB cap — rejected, not buffered.
  await check('APPEND over 25MB literal cap', async () => {
    const c = await login();
    const r = await c.run('h APPEND INBOX {40000000}\r\n', 'h', 4000).catch((e) => String(e));
    c.sock.destroy();
    return r;
  });

  // 6. Deeply nested SEARCH (recursion / node-count DoS).
  await check('deeply nested SEARCH OR/NOT', async () => {
    const c = await login();
    let q = 'UNSEEN';
    for (let i = 0; i < 5000; i++) q = `OR ${q} NOT ${q}`; // explodes if not bounded
    const cmd = `i SEARCH ${q}\r\n`.slice(0, 65000); // clamp to line cap
    const r = await c.run(cmd, 'i', 6000).catch((e) => String(e));
    c.sock.destroy();
    return r;
  });

  // 7. Binary garbage / NUL flood as commands.
  await check('binary garbage commands', async () => {
    const c = conn(imap.port);
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    for (let i = 0; i < 50; i++) c.raw(Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x41, 0x42]));
    await delay(200);
    c.sock.destroy();
    return 'flooded';
  });

  // 8. Rapid connect/disconnect churn — fd/handle leak?
  await check('2000 connect/disconnect churn', async () => {
    for (let i = 0; i < 2000; i++) {
      const s = net.connect(imap.port, '127.0.0.1');
      s.on('error', () => {});
      s.destroy();
    }
    await delay(500);
    return 'churned';
  });

  // 9. Pipelined command flood on one connection (many commands in one write).
  await check('10k pipelined NOOPs', async () => {
    const c = await login();
    let big = '';
    for (let i = 0; i < 10000; i++) big += `n${i} NOOP\r\n`;
    c.raw(Buffer.from(big, 'latin1'));
    const r = await c.run('zz NOOP\r\n', 'zz', 10000).catch((e) => String(e));
    c.sock.destroy();
    return r;
  });

  const rss = rssMB();
  await imap.close();
  db.close();
  dir.cleanup();

  console.log('\nAbuse harness — does pathological input crash / hang / wedge the server?\n');
  console.log([pad('attack', 40, true), pad('server alive after', 18), pad('last reply / note', 30, true)].join(' '));
  console.log('-'.repeat(90));
  for (const r of results) console.log([pad(r.attack, 40, true), pad(r.survived ? 'YES' : '*** NO ***', 18), pad(r.note, 30, true)].join(' '));
  console.log(`\nProcess RSS at end: ${rss.toFixed(0)} MB. Every "server alive after" must be YES.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
