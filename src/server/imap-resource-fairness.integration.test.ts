/**
 * Two shared IMAP resources one party could take more than its share of.
 *
 * 1. The in-flight APPEND budget bounds memory, but it was a single server-wide counter charged
 *    on the size the client DECLARES, before any of the literal arrives. Eleven connections
 *    declaring maximal literals and sending nothing pinned the whole budget, so every OTHER
 *    account's APPEND failed — Sent copies, drafts, imapsync imports — for as long as the
 *    attacker held the sockets. This is one of the few places a semi-trusted account reaches
 *    another, so the budget is now shared per principal.
 *
 * 2. IMAP had no protocol-error limit, while SMTP has had MAX_HARD_ERRORS with a comment
 *    describing exactly this hazard. An unauthenticated peer could answer tens of thousands of
 *    junk commands on one connection, resetting the inactivity timer with each, and occupy a
 *    connection slot indefinitely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(port: number): { sock: net.Socket; acc: () => string; closed: () => boolean; run: (w: string, re: RegExp) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  let closed = false;
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('close', () => (closed = true));
  sock.on('error', () => {});
  return {
    sock,
    acc: () => acc,
    closed: () => closed,
    run: async (w: string, re: RegExp): Promise<string> => {
      const from = acc.length;
      if (w !== '') sock.write(Buffer.from(w, 'latin1'));
      for (let i = 0; i < 400; i++) {
        if (re.test(acc.slice(from))) return acc.slice(from);
        await delay(5);
      }
      throw new Error(`timed out waiting for ${re}: ${acc.slice(from)}`);
    },
  };
}

test('one account cannot consume the whole APPEND budget and lock every other account out', async () => {
  // Two logins served by one ImapServer — the production shape, one listener for all accounts.
  const catalogs = new Map([
    ['mallory', new MemoryCatalog()],
    ['victim', new MemoryCatalog()],
  ]);
  const literal = 1024 * 1024; // 1 MiB max literal
  const server = await ImapServer.start(catalogs.get('mallory')!, {
    authenticate: (u, p) => catalogs.has(u) && p === 'pw',
    resolveAccount: (login) => {
      const c = catalogs.get(login);
      return c === undefined ? undefined : { catalog: c };
    },
    maxAppendLiteral: literal,
    maxAppendInflight: literal * 8, // 8 MiB total
  });

  const attackers: ReturnType<typeof connect>[] = [];
  try {
    // Declare literals and send NO body bytes, taking as much of the budget as we are allowed.
    let granted = 0;
    for (let i = 0; i < 12; i++) {
      const c = connect(server.port);
      attackers.push(c);
      await c.run('', /^\* OK/m);
      await c.run(`m${i}a LOGIN mallory pw\r\n`, /^m\d+a OK/m);
      const reply = await c.run(`m${i}b APPEND INBOX {${literal}}\r\n`, /^(\+|m\d+b NO)/m);
      if (reply.includes('+')) granted += 1;
    }
    assert.ok(granted > 0, 'sanity: some reservations are granted');
    assert.ok(granted < 12, `one account must not be able to take the whole budget (granted ${granted}/12)`);

    // The victim — a DIFFERENT account — must still be able to APPEND.
    const v = connect(server.port);
    attackers.push(v);
    await v.run('', /^\* OK/m);
    await v.run('v1 LOGIN victim pw\r\n', /^v1 OK/m);
    const vr = await v.run('v2 APPEND INBOX {20}\r\n', /^(\+|v2 NO)/m);
    assert.match(vr, /\+/, 'a second account must not be locked out by the first');
  } finally {
    for (const c of attackers) c.sock.destroy();
    await server.close();
  }
});

test('an unauthenticated peer streaming junk commands loses its connection slot', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => false });
  const c = connect(server.port);
  try {
    await c.run('', /^\* OK/m);
    // Pre-auth, unknown verbs. Without a limit these were answered indefinitely, each one
    // resetting the inactivity timer, so the slot was never reclaimed.
    for (let i = 0; i < 10 && !c.closed(); i++) {
      c.sock.write(Buffer.from(`x${i} FLOOBLE\r\n`, 'latin1'));
      await delay(20);
    }
    for (let i = 0; i < 200 && !c.closed(); i++) await delay(10);
    assert.equal(c.closed(), true, 'the peer must be dropped rather than answered forever');
    assert.match(c.acc(), /\* BYE too many invalid commands/);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('an ordinary client is never dropped for a stray bad command', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'pw' });
  const c = connect(server.port);
  try {
    await c.run('', /^\* OK/m);
    await c.run('a1 LOGIN alice pw\r\n', /^a1 OK/m);
    await c.run('a2 FLOOBLE\r\n', /^a2 BAD/m); // one typo from a real client
    await c.run('a3 NOOP\r\n', /^a3 OK/m);
    assert.equal(c.closed(), false, 'a single protocol error must not cost an authenticated client its session');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
