/**
 * Bounds on what one authenticated IMAP session can do: to another account, and to the
 * single event loop everyone else shares.
 *
 * Four defects, one shape between them — a rule enforced on one path and not on its twin.
 *
 *  - RFC 9051 §9's `command-nonauth` grammar makes LOGIN and AUTHENTICATE "valid only when in
 *    Not Authenticated state", but the state gate only fired when NOT authenticated, so both
 *    stayed reachable while Selected. `bindAccount` rebinds the catalog and never clears
 *    `selected`, and FETCH/STORE/EXPUNGE use that captured handle rather than re-deriving it —
 *    so re-authenticating as a second account kept the first account's mailbox open, and the
 *    revocation sweep then evaluated the NEW login. `account disable` plus a password rotation,
 *    the product's only two containment verbs, both stopped working.
 *  - APPEND was parsed by one regex with three `\s*` runs separated by two optional groups,
 *    which backtracks cubically when the trailing `{n}` fails to match. §6.3.12's grammar has
 *    exactly one SP between components, so pinning each separator removes the ambiguity.
 *  - `statusItems` de-duplicates its item list because §9 permits repeats and each costs a
 *    mailbox scan. `fetch-att *(SP fetch-att)` is the same grammar shape and each repeat costs
 *    a whole BODY copy, and that list was neither de-duplicated nor capped.
 *  - CREATE had no length or depth limit, and LIST rebuilds every ancestor prefix, so one
 *    64 KB mailbox name made every later LIST quadratic — and the name is stored, so it stayed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(port: number): { sock: net.Socket; run: (cmds: string, doneTag: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (cmds: string, doneTag: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(cmds, 'latin1'));
    for (let i = 0; i < 2000; i++) {
      if (new RegExp(`^${doneTag} (OK|NO|BAD)`, 'm').test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timed out on ${doneTag}: ${acc.slice(from)}`);
  };
  return { sock, run };
}

const plainToken = (user: string, pass: string): string =>
  Buffer.from(`\0${user}\0${pass}`, 'latin1').toString('base64');

test('re-authenticating does not carry the previous account\'s mailbox into the new session', async () => {
  cites('R-9051-9-b');
  const alice = new MemoryCatalog();
  alice.get('INBOX')!.append(Buffer.from('Subject: ALICE-SECRET\r\n\r\nprivate\r\n', 'latin1'));
  const bob = new MemoryCatalog();
  const stores: Record<string, MemoryCatalog> = { alice, bob };

  let aliceEnabled = true;
  const server = await ImapServer.start(alice, {
    authenticate: (u, p) => (u === 'alice' && p === 'apw') || (u === 'bob' && p === 'bpw'),
    resolveAccount: (login) => {
      const catalog = stores[login];
      return catalog === undefined ? undefined : { catalog };
    },
    isEnabled: (login) => (login === 'alice' ? aliceEnabled : true),
    revocationSweepMs: 50,
  });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');
    const sel = await c.run('a2 SELECT INBOX\r\n', 'a2');
    assert.match(sel, /^a2 OK/m, 'alice can select her own INBOX');

    // The attack: relabel the session to an account the attacker legitimately controls.
    const reauth = await c.run(`a3 AUTHENTICATE PLAIN ${plainToken('bob', 'bpw')}\r\n`, 'a3');
    assert.match(
      reauth,
      /^a3 BAD/m,
      'RFC 9051 §9: AUTHENTICATE is valid only in the Not Authenticated state',
    );

    // And the containment verb still reaches this session.
    aliceEnabled = false;
    await delay(200);
    const after = await c.run('a4 FETCH 1 (BODY[])\r\n', 'a4').catch(() => 'closed');
    assert.ok(
      after === 'closed' || /ALICE-SECRET/.test(after) === false,
      `a disabled account's session must not still read its mail, got: ${after}`,
    );
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('LOGIN is refused once authenticated, so one credential cannot loop key derivation', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'apw' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');
    const again = await c.run('a2 LOGIN alice apw\r\n', 'a2');
    assert.match(again, /^a2 BAD/m, 'a second LOGIN on an authenticated session is refused');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('an APPEND line of runaway whitespace is answered promptly, not parsed cubically', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'apw' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');

    // No trailing {n}, so the match fails — which is what forced the engine to try every
    // partition of the whitespace run across the three \s* groups.
    const payload = `a2 APPEND x${'\t'.repeat(4000)}Z\r\n`;
    const started = Date.now();
    const reply = await c.run(payload, 'a2');
    const elapsed = Date.now() - started;

    assert.match(reply, /^a2 BAD/m, 'malformed APPEND is still a syntax error');
    // The defect took ~15 s for this input and scaled ~9x per doubling; the 64 KiB line cap
    // left room for hours. A linear matcher answers immediately.
    assert.ok(elapsed < 2000, `APPEND parsing must be linear; took ${elapsed}ms`);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('APPEND still accepts every form RFC 9051 §6.3.12 allows', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'apw' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');
    const body = 'Subject: t\r\n\r\nx\r\n';
    const lit = `{${Buffer.byteLength(body, 'latin1')}+}`;
    // The literal octets are followed by the CRLF that terminates the command line itself
    // (RFC 9051 §4.3): the body's own trailing CRLF is inside the count, not that terminator.
    const tail = `\r\n${body}\r\n`;
    const forms: ReadonlyArray<readonly [string, string]> = [
      ['b1', `b1 APPEND INBOX ${lit}${tail}`],
      ['b2', `b2 APPEND "INBOX" ${lit}${tail}`],
      ['b3', `b3 APPEND INBOX (\\Seen) ${lit}${tail}`],
      ['b4', `b4 APPEND INBOX (\\Seen \\Draft) ${lit}${tail}`],
      ['b5', `b5 APPEND INBOX "01-Jan-2024 00:00:00 +0000" ${lit}${tail}`],
      ['b6', `b6 APPEND INBOX (\\Seen \\Draft) "01-Jan-2024 00:00:00 +0000" ${lit}${tail}`],
    ];
    for (const [tag, cmd] of forms) {
      const reply = await c.run(cmd, tag);
      assert.match(reply, new RegExp(`^${tag} OK`, 'm'), `APPEND form must be accepted: ${cmd.split('\r\n')[0]}`);
    }
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('a repeated BODY[] section costs no more than asking for it once', async () => {
  const cat = new MemoryCatalog();
  const oneMib = Buffer.concat([
    Buffer.from('Subject: big\r\n\r\n', 'latin1'),
    Buffer.alloc(1024 * 1024, 0x41),
  ]);
  cat.get('INBOX')!.append(oneMib);
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'apw' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');
    await c.run('a2 SELECT INBOX\r\n', 'a2');

    const once = await c.run('a3 FETCH 1 (BODY.PEEK[])\r\n', 'a3');
    const repeated = await c.run(`a4 FETCH 1 (${'BODY.PEEK[] '.repeat(200).trim()})\r\n`, 'a4');

    // The defect emitted the body once per repeat and concatenated the lot into one contiguous
    // buffer: 200 x 1 MiB from a ~2.4 KB command.
    assert.ok(
      repeated.length < once.length * 3,
      `200 repeats emitted ${repeated.length} bytes vs ${once.length} for one — sections must be de-duplicated`,
    );
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('CREATE refuses a mailbox name deep enough to make LIST quadratic', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'apw' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1 LOGIN alice apw\r\n', 'a1');

    const deep = Array.from({ length: 4000 }, () => 'a').join('/');
    const created = await c.run(`a2 CREATE ${deep}\r\n`, 'a2');
    assert.match(created, /^a2 NO/m, 'an absurdly deep mailbox name is refused at CREATE');

    // A realistic nest is still fine.
    const ok = await c.run('a3 CREATE Projects/2026/Clients/Acme\r\n', 'a3');
    assert.match(ok, /^a3 OK/m, 'ordinary nested mailboxes are unaffected');

    const started = Date.now();
    await c.run('a4 LIST "" *\r\n', 'a4');
    assert.ok(Date.now() - started < 2000, 'LIST stays fast when no pathological name was stored');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
