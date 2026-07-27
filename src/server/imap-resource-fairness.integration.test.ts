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

test('spelling the same login in different cases does not buy extra APPEND budget', async () => {
  // The per-principal slice above is only a slice if the key IS the principal. Authentication
  // resolves on lower(login) and MailStores keys its cache the same way, so every spelling below is
  // one account sharing one mailbox — but keyed on the raw wire spelling they counted as separate
  // principals, and the cross-account lockout the slice exists to prevent came straight back.
  const catalogs = new Map([
    ['mallory', new MemoryCatalog()],
    ['victim', new MemoryCatalog()],
  ]);
  const literal = 1024 * 1024;
  const server = await ImapServer.start(catalogs.get('mallory')!, {
    authenticate: (u, p) => catalogs.has(u.toLowerCase()) && p === 'pw',
    resolveAccount: (login) => {
      const c = catalogs.get(login.toLowerCase());
      return c === undefined ? undefined : { catalog: c };
    },
    maxAppendLiteral: literal,
    maxAppendInflight: literal * 8,
  });

  const socks: ReturnType<typeof connect>[] = [];
  try {
    // Twelve spellings of ONE login. Under the defect each got its own slice.
    const spellings = ['mallory', 'Mallory', 'mAllory', 'maLlory', 'malLory', 'mallOry', 'mallInvalid'.replace('Invalid', 'Ory'), 'MALLORY', 'MAllory', 'mALLORY', 'MaLlOrY', 'mAlLoRy'];
    let granted = 0;
    for (const [i, spelling] of spellings.entries()) {
      const c = connect(server.port);
      socks.push(c);
      await c.run('', /^\* OK/m);
      await c.run(`m${i}a LOGIN ${spelling} pw\r\n`, /^m\d+a OK/m);
      const reply = await c.run(`m${i}b APPEND INBOX {${literal}}\r\n`, /^(\+|m\d+b NO)/m);
      if (reply.includes('+')) granted += 1;
    }
    assert.ok(granted < spellings.length, `case variants must not each get a slice (granted ${granted}/${spellings.length})`);

    const v = connect(server.port);
    socks.push(v);
    await v.run('', /^\* OK/m);
    await v.run('v1 LOGIN victim pw\r\n', /^v1 OK/m);
    const vr = await v.run('v2 APPEND INBOX {20}\r\n', /^(\+|v2 NO)/m);
    assert.match(vr, /\+/, 'a different account must still be served');
  } finally {
    for (const c of socks) c.sock.destroy();
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

test('a repeated STATUS item does not multiply the passes over a mailbox', async () => {
  // RFC 9051 §9 permits `status-att *(SP status-att)` with no uniqueness rule, so a repeat is legal
  // and cannot be answered BAD. Each of UNSEEN, SIZE and DELETED costs a pass over the mailbox, and
  // LIST … RETURN (STATUS …) runs the list once per matched mailbox — so the cost was
  // mailboxes × items × messages, all three chosen by the client, and Node being single-threaded
  // that freezes every other account's session, inbound SMTP and the relay loop with it.
  //
  // Counted rather than timed. A wall-clock assertion here passed with the defect in place on this
  // machine, which would have made it a test that cannot fail; the number of index() passes is the
  // thing the fix actually changes.
  const cat = new MemoryCatalog();
  for (const name of ['one', 'two', 'three']) {
    cat.create(name);
    const b = cat.get(name)!;
    for (let i = 0; i < 5; i++) b.append(Buffer.from(`Subject: m${i}\r\n\r\nbody\r\n`, 'latin1'), [], 1);
  }
  // index() is called once per mailbox either way; the repeats re-scan the array it returned. So
  // the thing to count is the scans of that array, not the calls that produced it.
  let scans = 0;
  const counting = {
    listNames: () => cat.listNames(),
    create: (name: string) => cat.create(name),
    delete: (name: string) => cat.delete(name),
    rename: (from: string, to: string) => cat.rename(from, to),
    get: (name: string) => {
      const box = cat.get(name);
      if (box === undefined) return undefined;
      return new Proxy(box, {
        get(target, prop, recv) {
          if (prop === 'index') {
            return (...args: unknown[]) => {
              const rows = (target.index as (...a: unknown[]) => unknown[])(...args);
              return new Proxy(rows, {
                get(arr, key, r2) {
                  if (key === 'filter' || key === 'reduce') scans++;
                  return Reflect.get(arr, key, r2) as unknown;
                },
              });
            };
          }
          return Reflect.get(target, prop, recv) as unknown;
        },
      });
    },
  } as unknown as MemoryCatalog;

  const server = await ImapServer.start(counting, { authenticate: () => true });
  const c = connect(server.port);
  try {
    await c.run('', /^\* OK/m);
    await c.run('a1 LOGIN u p\r\n', /^a1 OK/m);

    scans = 0;
    await c.run('a2 LIST "" * RETURN (STATUS (UNSEEN))\r\n', /^a2 OK/m);
    const baseline = scans;
    assert.ok(baseline > 0, 'sanity: the counting proxy sees the scans');

    scans = 0;
    const many = Array(500).fill('UNSEEN').join(' ');
    await c.run(`a3 LIST "" * RETURN (STATUS (${many}))\r\n`, /^a3 OK/m);
    assert.equal(scans, baseline, `500 repeats must cost what one costs, got ${scans} scans against ${baseline}`);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('a repeated STATUS item is answered once, as the ABNF permits it to be sent', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('Subject: one\r\n\r\nx\r\n', 'latin1'), [], 1);
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = connect(server.port);
  try {
    await c.run('', /^\* OK/m);
    await c.run('a1 LOGIN u p\r\n', /^a1 OK/m);
    const reply = await c.run('a2 STATUS INBOX (MESSAGES UNSEEN MESSAGES UNSEEN)\r\n', /^a2 OK/m);
    const line = reply.split('\r\n').find((l) => l.startsWith('* STATUS'))!;
    assert.equal((line.match(/MESSAGES /g) ?? []).length, 1, `each item appears once: ${line}`);
    assert.equal((line.match(/UNSEEN /g) ?? []).length, 1, `each item appears once: ${line}`);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
