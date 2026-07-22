/**
 * IMAP4rev2 conformance fixes, each reproduce-first (a test that fails on the old behaviour and
 * passes on the new one). Grouped by the defect each targets:
 *
 *   §6.3.2  * OK [CLOSED] on mailbox switch, and the REQUIRED untagged LIST in a SELECT response.
 *   §6.4.5  FETCH of an unknown/unsupported data item is a tagged BAD, not a silent FLAGS+UID.
 *   §6.4.4  SEARCH answers ESEARCH once IMAP4rev2 is ENABLEd; unknown RETURN options are BAD.
 *   7162    the VANISHED FETCH modifier requires ENABLE QRESYNC.
 *   §7.1    PERMANENTFLAGS advertises \* and keywords appear in the FLAGS response and persist.
 *   §5.1    non-ASCII (UTF-8) mailbox names round-trip byte-transparently; mUTF-7 is not decoded.
 *   §6.3.4  a CREATEd hierarchy's non-existent parent is walkable as (\NonExistent \HasChildren).
 *   §6.3.12 a self-APPEND into the selected mailbox is visible to a following bare-sequence command.
 *   §6.4.5  partial BODY[...]<origin.count> slices (the Thunderbird preview path).
 *   caps    the per-listener connection ceiling refuses the excess and spares existing sessions.
 *   plus    the cheap LOW-priority grammar/value pins (UID EXPUNGE set, malformed set, TRYCREATE,
 *           UNCHANGEDSINCE 0, AUTHENTICATE cancel/mechanism, ENABLE-when-selected, STATUS values).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly #sock: net.Socket;
  constructor(sock: net.Socket) {
    this.#sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  async run(tag: string, command: string): Promise<string> {
    const from = this.#acc.length;
    this.#sock.write(Buffer.from(`${tag} ${command}\r\n`, 'latin1'));
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.subarray(from).toString('latin1');
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(s)) return s;
      await delay(5);
    }
    throw new Error(`timed out on ${tag} ${command}: ${this.#acc.subarray(from).toString('latin1')}`);
  }
  raw(bytes: string): void {
    this.#sock.write(Buffer.from(bytes, 'latin1'));
  }
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      if (s.includes(needle)) return s;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}: ${this.#acc.toString('latin1')}`);
  }
  async greeting(): Promise<string> {
    return this.waitFor('* OK');
  }
}

/** Start a server on a fresh MemoryCatalog and return a logged-in Session plus teardown. */
async function loggedIn(
  seed?: (cat: MemoryCatalog) => void,
): Promise<{ s: Session; server: ImapServer; sock: net.Socket; cat: MemoryCatalog }> {
  const cat = new MemoryCatalog();
  seed?.(cat);
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  await s.greeting();
  await s.run('login', 'LOGIN u p');
  return { s, server, sock, cat };
}

// ── §6.3.2: * OK [CLOSED] on mailbox switch, and the untagged LIST in SELECT ──────────────────

test('SELECT while a mailbox is selected emits * OK [CLOSED] before the new mailbox responses (§6.3.2)', async () => {
  const { s, server, sock } = await loggedIn((c) => c.create('Work'));
  try {
    // The FIRST select has no prior mailbox, so NO [CLOSED].
    const first = await s.run('a1', 'SELECT INBOX');
    assert.doesNotMatch(first, /\[CLOSED\]/, 'the first SELECT does not deselect anything, so no CLOSED');
    // The REQUIRED untagged LIST for the mailbox (§6.3.2).
    assert.match(first, /^\* LIST \([^)]*\) "\/" INBOX\r$/m, 'SELECT includes the untagged LIST for the mailbox');

    // The SECOND select deselects INBOX first: MUST emit * OK [CLOSED] before the new responses.
    const second = await s.run('a2', 'SELECT Work');
    assert.match(second, /^\* OK \[CLOSED\]/m, 'switching mailboxes emits * OK [CLOSED]');
    assert.ok(second.indexOf('[CLOSED]') < second.indexOf('EXISTS'), 'CLOSED precedes the new mailbox untagged responses');
    assert.match(second, /^\* LIST \([^)]*\) "\/" Work\r$/m, 'the untagged LIST names the newly selected mailbox');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('a FAILED SELECT of a missing mailbox still deselects, so it emits * OK [CLOSED] (§6.3.2)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX');
    const miss = await s.run('a2', 'SELECT Nope');
    assert.match(miss, /^\* OK \[CLOSED\]/m, 'a failed SELECT deselects the old mailbox, emitting CLOSED');
    assert.match(miss, /^a2 NO/m, 'and then reports the missing mailbox');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('CLOSE and UNSELECT do NOT emit [CLOSED] (negative control, §6.4.2)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX');
    const close = await s.run('a2', 'CLOSE');
    assert.doesNotMatch(close, /\[CLOSED\]/, 'CLOSE has no [CLOSED] response code');
    await s.run('a3', 'SELECT INBOX');
    const unsel = await s.run('a4', 'UNSELECT');
    assert.doesNotMatch(unsel, /\[CLOSED\]/, 'UNSELECT has no [CLOSED] response code');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('the QRESYNC ENABLE + SELECT A + SELECT B boundary still emits [CLOSED] on the switch', async () => {
  const { s, server, sock } = await loggedIn((c) => c.create('Work'));
  try {
    await s.run('a1', 'ENABLE QRESYNC');
    await s.run('a2', 'SELECT INBOX');
    const b = await s.run('a3', 'SELECT Work');
    assert.match(b, /^\* OK \[CLOSED\]/m, 'CLOSED is emitted on the switch even with QRESYNC enabled');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §6.4.5: FETCH of an unknown data item is a tagged BAD ─────────────────────────────────────

test('FETCH of an unknown or unsupported data item is a tagged BAD, not a silent FLAGS+UID (§6.4.5)', async () => {
  const { s, server, sock } = await loggedIn((c) => c.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1')));
  try {
    await s.run('a1', 'SELECT INBOX');
    assert.match(await s.run('a2', 'FETCH 1 (BOGUS)'), /^a2 BAD/m, 'a wholly unknown att is BAD');
    assert.match(await s.run('a3', 'FETCH 1 (FLAGS BOGUS)'), /^a3 BAD/m, 'a mix of known + unknown is BAD');
    assert.match(await s.run('a4', 'FETCH 1 (BINARY[1])'), /^a4 BAD/m, 'BINARY.* is rejected loudly (out of scope)');
    assert.match(await s.run('a5', 'FETCH 1 (BINARY.SIZE[1])'), /^a5 BAD/m, 'BINARY.SIZE too');
    // Control: a known att still works and returns data.
    const ok = await s.run('a6', 'FETCH 1 (FLAGS)');
    assert.match(ok, /^\* 1 FETCH \(FLAGS \(\)\)\r$/m, 'FLAGS still returns its data');
    assert.match(ok, /^a6 OK/m);
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §6.4.4: ESEARCH under IMAP4rev2, and RETURN-option rejection ──────────────────────────────

test('plain SEARCH is legacy * SEARCH until IMAP4rev2 is ENABLEd, then ESEARCH (§6.4.4)', async () => {
  const { s, server, sock } = await loggedIn((c) => {
    c.get('INBOX')!.append(Buffer.from('Subject: a\r\n\r\nb\r\n', 'latin1'));
    c.get('INBOX')!.append(Buffer.from('Subject: c\r\n\r\nd\r\n', 'latin1'));
  });
  try {
    await s.run('a1', 'SELECT INBOX');
    const legacy = await s.run('a2', 'SEARCH ALL');
    assert.match(legacy, /^\* SEARCH 1 2\r$/m, 'an un-ENABLEd session gets the legacy * SEARCH');
    assert.doesNotMatch(legacy, /ESEARCH/, 'and NOT ESEARCH');

    // ENABLE must precede SELECT (it is invalid once selected), so re-open the session cleanly.
    await s.run('a3', 'CLOSE');
    await s.run('a4', 'ENABLE IMAP4rev2');
    await s.run('a5', 'SELECT INBOX');
    const esearch = await s.run('a6', 'SEARCH ALL');
    assert.match(esearch, /^\* ESEARCH \(TAG "a6"\) ALL 1:2\r$/m, 'a rev2-enabled plain SEARCH answers ESEARCH with ALL');
    assert.doesNotMatch(esearch, /^\* SEARCH/m, 'and NOT the legacy form');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('a RETURN search always emits ESEARCH, even on zero hits (§6.4.4)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX'); // empty INBOX
    const zero = await s.run('a2', 'SEARCH RETURN (COUNT) ALL');
    assert.match(zero, /^\* ESEARCH \(TAG "a2"\) COUNT 0\r$/m, 'ESEARCH with COUNT 0 is emitted even with no matches');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('unknown or unsupported SEARCH RETURN options are rejected with BAD (§6.4.4)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX');
    assert.match(await s.run('a2', 'SEARCH RETURN (SAVE) ALL'), /^a2 BAD/m, 'RETURN (SAVE) — SEARCHRES is declined scope — is BAD');
    assert.match(await s.run('a3', 'SEARCH RETURN (BOGUS) ALL'), /^a3 BAD/m, 'an unknown RETURN option is BAD');
    // Control: a supported combination is accepted.
    assert.match(await s.run('a4', 'SEARCH RETURN (MIN MAX COUNT) ALL'), /^a4 OK/m, 'MIN/MAX/COUNT are accepted');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('FETCH $ (the SEARCHRES marker) is a tagged BAD, not a silent empty result (§6.4.4)', async () => {
  const { s, server, sock } = await loggedIn((c) => c.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1')));
  try {
    await s.run('a1', 'SELECT INBOX');
    assert.match(await s.run('a2', 'FETCH $ (FLAGS)'), /^a2 BAD/m, 'FETCH $ is BAD — the marker is never filled');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── RFC 7162 §3.2.6: VANISHED FETCH modifier requires ENABLE QRESYNC ──────────────────────────

test('the VANISHED FETCH modifier requires ENABLE QRESYNC (RFC 7162 §3.2.6)', async () => {
  const { s, server, sock } = await loggedIn((c) => c.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1')));
  try {
    // No ENABLE QRESYNC: a UID FETCH with CHANGEDSINCE .. VANISHED is BAD even though the
    // uidMode + CHANGEDSINCE preconditions are met.
    await s.run('a1', 'SELECT INBOX');
    const misuse = await s.run('a2', 'UID FETCH 1 (FLAGS) (CHANGEDSINCE 0 VANISHED)');
    assert.match(misuse, /^a2 BAD/m, 'VANISHED without ENABLE QRESYNC is rejected');

    // Enable QRESYNC (before re-selecting) and the same command is accepted.
    await s.run('a3', 'CLOSE');
    await s.run('a4', 'ENABLE QRESYNC');
    await s.run('a5', 'SELECT INBOX');
    const ok = await s.run('a6', 'UID FETCH 1 (FLAGS) (CHANGEDSINCE 0 VANISHED)');
    assert.match(ok, /^a6 OK/m, 'the happy path works once QRESYNC is enabled');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §7.1: PERMANENTFLAGS \* and keyword persistence ───────────────────────────────────────────

test('PERMANENTFLAGS advertises \\* and stored keywords survive a reconnect and appear in FLAGS (§7.1)', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  try {
    // Session 1: SELECT read-write, confirm \* is advertised, store a keyword.
    const sock1 = net.connect(server.port, '127.0.0.1');
    const s1 = new Session(sock1);
    await s1.greeting();
    await s1.run('a1', 'LOGIN u p');
    const sel = await s1.run('a2', 'SELECT INBOX');
    assert.match(sel, /^\* OK \[PERMANENTFLAGS \([^)]*\\\*\)\]/m, 'read-write PERMANENTFLAGS includes \\*');
    await s1.run('a3', String.raw`STORE 1 +FLAGS ($Label1)`);
    sock1.destroy();

    // Session 2: a fresh connection sees the keyword in the FLAGS response and on the message.
    const sock2 = net.connect(server.port, '127.0.0.1');
    const s2 = new Session(sock2);
    await s2.greeting();
    await s2.run('b1', 'LOGIN u p');
    const sel2 = await s2.run('b2', 'SELECT INBOX');
    assert.match(sel2, /^\* FLAGS \([^)]*\$Label1[^)]*\)\r$/m, 'the keyword appears in the FLAGS response after reconnect');
    const fetched = await s2.run('b3', 'FETCH 1 (FLAGS)');
    assert.match(fetched, /\$Label1/, 'the keyword persisted on the message');
    sock2.destroy();

    // EXAMINE advertises no settable permanent flags.
    const sock3 = net.connect(server.port, '127.0.0.1');
    const s3 = new Session(sock3);
    await s3.greeting();
    await s3.run('c1', 'LOGIN u p');
    const ex = await s3.run('c2', 'EXAMINE INBOX');
    assert.match(ex, /^\* OK \[PERMANENTFLAGS \(\)\]/m, 'EXAMINE advertises PERMANENTFLAGS ()');
    sock3.destroy();
  } finally {
    await server.close();
  }
});

// ── §5.1: non-ASCII mailbox names round-trip byte-transparently ───────────────────────────────

test('a UTF-8 mailbox name round-trips byte-transparently through CREATE/LIST/SELECT/STATUS (§5.1)', async () => {
  const { s, server, sock, cat } = await loggedIn();
  try {
    const cafe = 'caf\xc3\xa9'; // "café" as its 5 UTF-8 octets, read latin1 (one char per byte)
    assert.match(await s.run('a1', `CREATE "${cafe}"`), /^a1 OK/m);
    assert.deepEqual([...cat.listNames()].sort(), ['INBOX', cafe], 'the name is stored as the exact octets');
    // LIST returns the name as a length-5 literal carrying the exact bytes (never a bare 8-bit atom).
    const list = await s.run('a2', 'LIST "" "*"');
    assert.ok(list.includes(`{5}\r\n${cafe}`), 'LIST serialises the 8-bit name as a byte-exact literal');
    // SELECT and STATUS resolve the same octets.
    assert.match(await s.run('a3', `SELECT "${cafe}"`), /^a3 OK \[READ-WRITE\]/m, 'SELECT resolves the UTF-8 name');
    const status = await s.run('a4', `STATUS "${cafe}" (MESSAGES UIDNEXT)`);
    assert.ok(status.includes(`* STATUS {5}\r\n${cafe} (MESSAGES 0 UIDNEXT 1)`), 'STATUS round-trips the name');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('an mUTF-7-shaped name is stored verbatim, never decoded (rev2 dropped modified-UTF-7, §5.1)', async () => {
  const { s, server, sock, cat } = await loggedIn();
  try {
    // "Fo&AOk-o" is the modified-UTF-7 encoding of "Foéo". A rev2 server MUST NOT decode it.
    assert.match(await s.run('a1', 'CREATE "Fo&AOk-o"'), /^a1 OK/m);
    assert.ok(cat.listNames().includes('Fo&AOk-o'), 'the literal ASCII bytes are stored, not the decoded form');
    assert.ok(!cat.listNames().some((n) => n.includes('\xc3\xa9')), 'it was NOT decoded to Foéo');
    const list = await s.run('a2', 'LIST "" "*"');
    // The name is a valid atom (& and - are not atom-specials), so it comes back bare and verbatim.
    assert.match(list, /^\* LIST \([^)]*\) "\/" Fo&AOk-o\r$/m, 'and it is returned verbatim, undecoded');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §6.3.4: a CREATEd hierarchy's non-existent parent is walkable ─────────────────────────────

test('a hierarchy CREATE surfaces its non-existent parents as (\\NonExistent \\HasChildren) in a %-walk (§6.3.4)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'CREATE "a/b/c"'); // only the leaf is created
    // A top-level %-walk (which stays within one level) must surface the intermediate "a".
    const walk = await s.run('a2', 'LIST "" "%"');
    assert.match(walk, /^\* LIST \(\\NonExistent \\HasChildren\) "\/" a\r$/m, 'the non-existent parent "a" is walkable');
    // The next level down shows "a/b", also non-existent-with-children.
    const walk2 = await s.run('a3', 'LIST "" "a/%"');
    assert.match(walk2, /^\* LIST \(\\NonExistent \\HasChildren\) "\/" a\/b\r$/m, 'the next intermediate "a/b" too');
    // A full walk still shows the real leaf.
    assert.match(await s.run('a4', 'LIST "" "*"'), /^\* LIST \([^)]*\) "\/" a\/b\/c\r$/m, 'the real leaf is listed');
    // The intermediates are NOT selectable — they do not exist.
    assert.match(await s.run('a5', 'SELECT a'), /^a5 NO/m, 'the intermediate is not selectable');
    assert.match(await s.run('a6', 'STATUS a (MESSAGES)'), /^a6 NO/m, 'and STATUS of it is refused');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §6.3.12: self-APPEND into the selected mailbox is visible to a bare-sequence command ───────

test('a self-APPEND into the selected mailbox announces EXISTS before its OK and is then fetchable by sequence (§6.3.12)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX'); // empty
    const msg = 'Subject: filed\r\n\r\nby me\r\n';
    s.raw(`a2 APPEND "INBOX" {${msg.length}}\r\n`);
    await s.waitFor('+ Ready');
    s.raw(`${msg}\r\n`);
    const appended = await s.waitFor('a2 OK');
    // The untagged EXISTS for the just-filed message MUST arrive before the tagged OK, so a
    // following bare-sequence command can address it.
    assert.match(appended, /^\* 1 EXISTS\r$/m, 'EXISTS is announced for the self-APPEND');
    assert.ok(appended.indexOf('1 EXISTS') < appended.indexOf('a2 OK'), 'EXISTS precedes the tagged OK');
    // And the new message is addressable by sequence number 1.
    const fetched = await s.run('a3', 'FETCH 1 (UID)');
    assert.match(fetched, /^\* 1 FETCH \(UID 1\)\r$/m, 'the just-appended message is fetchable by sequence');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── §6.4.5: partial BODY[...]<origin.count> slices ────────────────────────────────────────────

test('partial BODY[...]<origin.count> fetch: exact, mid-slice, past-end, overrun, and .PEEK (§6.4.5)', async () => {
  const body = 'Subject: p\r\n\r\n0123456789\r\n'; // TEXT section is "0123456789\r\n" (12 octets)
  const { s, server, sock, cat } = await loggedIn((c) => c.get('INBOX')!.append(Buffer.from(body, 'latin1')));
  try {
    await s.run('a1', 'SELECT INBOX');

    // Exact octets from the origin: BODY[TEXT]<0.5> → "01234", declared {5}, tagged <0>.
    const exact = await s.run('a2', 'FETCH 1 (BODY.PEEK[TEXT]<0.5>)');
    assert.ok(exact.includes('BODY[TEXT]<0> {5}\r\n01234'), 'origin 0 count 5 returns the first 5 octets');

    // A mid-origin slice: <3.4> → "3456".
    const mid = await s.run('a3', 'FETCH 1 (BODY.PEEK[TEXT]<3.4>)');
    assert.ok(mid.includes('BODY[TEXT]<3> {4}\r\n3456'), 'a mid-origin slice returns the right window');

    // Origin past the end: <100.5> → empty {0}.
    const past = await s.run('a4', 'FETCH 1 (BODY.PEEK[TEXT]<100.5>)');
    assert.ok(past.includes('BODY[TEXT]<100> {0}\r\n'), 'an origin past the end yields an empty {0} literal');

    // A count overrunning the end is truncated, with the DECLARED length matching the octets sent.
    const overrun = await s.run('a5', 'FETCH 1 (BODY.PEEK[TEXT]<8.999>)');
    const m = /BODY\[TEXT\]<8> \{(\d+)\}\r\n/.exec(overrun);
    assert.ok(m !== null, 'the overrun slice is returned');
    // TEXT is "0123456789\r\n" (12 octets); from origin 8 that leaves 4 octets ("89\r\n").
    assert.equal(Number(m![1]), 4, 'the declared length is the truncated octet count, not the requested count');

    // .PEEK does NOT set \Seen.
    assert.ok(!cat.get('INBOX')!.messages[0]!.flags.has('\\Seen'), 'BODY.PEEK[...] leaves \\Seen unset');

    // A non-.PEEK partial fetch DOES set \Seen (the implicit mark).
    await s.run('a6', 'FETCH 1 (BODY[TEXT]<0.3>)');
    assert.ok(cat.get('INBOX')!.messages[0]!.flags.has('\\Seen'), 'a non-peek BODY[...] fetch marks \\Seen');
  } finally {
    sock.destroy();
    await server.close();
  }
});

// ── Per-listener connection cap ───────────────────────────────────────────────────────────────

test('the per-listener connection cap refuses the excess and spares existing sessions', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true, maxConnections: 2 });
  const opened: net.Socket[] = [];
  const greet = async (sock: net.Socket, ms: number): Promise<boolean> => {
    let got = false;
    sock.on('data', (d: Buffer) => { if (d.toString('latin1').includes('* OK')) got = true; });
    sock.on('error', () => {});
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !got) await delay(10);
    return got;
  };
  try {
    const s1 = net.connect(server.port, '127.0.0.1');
    const s2 = net.connect(server.port, '127.0.0.1');
    opened.push(s1, s2);
    assert.ok(await greet(s1, 500), 'the first connection is served');
    assert.ok(await greet(s2, 500), 'the second connection is served (at the cap)');

    // The third connection is over the cap: no greeting, and the socket is closed by the server.
    const s3 = net.connect(server.port, '127.0.0.1');
    opened.push(s3);
    let closed = false;
    s3.on('close', () => (closed = true));
    assert.equal(await greet(s3, 400), false, 'the over-cap connection gets no greeting');
    assert.ok(closed || s3.destroyed, 'the excess connection is dropped');

    // The existing sessions still work.
    s1.write(Buffer.from('a1 CAPABILITY\r\n', 'latin1'));
    let capOk = false;
    s1.on('data', (d: Buffer) => { if (d.toString('latin1').includes('a1 OK')) capOk = true; });
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !capOk) await delay(10);
    assert.ok(capOk, 'an existing session survives the excess connection being refused');
  } finally {
    for (const so of opened) so.destroy();
    await server.close();
  }
});

test('lowering the connection cap moves the boundary (negative control)', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true, maxConnections: 1 });
  const opened: net.Socket[] = [];
  const greet = async (sock: net.Socket, ms: number): Promise<boolean> => {
    let got = false;
    sock.on('data', (d: Buffer) => { if (d.toString('latin1').includes('* OK')) got = true; });
    sock.on('error', () => {});
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !got) await delay(10);
    return got;
  };
  try {
    const s1 = net.connect(server.port, '127.0.0.1');
    opened.push(s1);
    assert.ok(await greet(s1, 500), 'the single allowed connection is served');
    const s2 = net.connect(server.port, '127.0.0.1');
    opened.push(s2);
    assert.equal(await greet(s2, 400), false, 'with cap 1 the SECOND connection is already refused');
  } finally {
    for (const so of opened) so.destroy();
    await server.close();
  }
});

// ── LOW-priority grammar / value pins ─────────────────────────────────────────────────────────

test('UID EXPUNGE requires a sequence set; a bare or malformed one is BAD (RFC 4315)', async () => {
  const { s, server, sock, cat } = await loggedIn((c) => {
    c.get('INBOX')!.append(Buffer.from('a'));
    c.get('INBOX')!.append(Buffer.from('b'));
  });
  try {
    await s.run('a1', 'SELECT INBOX');
    await s.run('a2', String.raw`STORE 1:2 +FLAGS (\Deleted)`); // both marked \Deleted
    // A bare `UID EXPUNGE` (no set) must NOT fall through to a full EXPUNGE — it is BAD.
    assert.match(await s.run('a3', 'UID EXPUNGE'), /^a3 BAD/m, 'bare UID EXPUNGE is BAD');
    assert.match(await s.run('a4', 'UID EXPUNGE abc'), /^a4 BAD/m, 'a malformed UID EXPUNGE set is BAD');
    assert.equal(cat.get('INBOX')!.messages.length, 2, 'nothing was expunged by the rejected commands');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('a malformed FETCH sequence-set is a tagged BAD, not a silent empty OK (§9)', async () => {
  const { s, server, sock } = await loggedIn((c) => c.get('INBOX')!.append(Buffer.from('a')));
  try {
    await s.run('a1', 'SELECT INBOX');
    assert.match(await s.run('a2', 'FETCH abc (FLAGS)'), /^a2 BAD/m, 'FETCH abc is BAD');
    // Control: a well-formed set is accepted.
    assert.match(await s.run('a3', 'FETCH 1 (FLAGS)'), /^a3 OK/m);
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('APPEND to a missing mailbox is NO [TRYCREATE] (RFC 9051 §6.3.12)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    const msg = 'Subject: x\r\n\r\nb\r\n';
    s.raw(`a1 APPEND "Nowhere" {${msg.length}}\r\n`);
    await s.waitFor('+ Ready');
    s.raw(`${msg}\r\n`);
    const resp = await s.waitFor('a1 ');
    assert.match(resp, /^a1 NO \[TRYCREATE\]/m, 'APPEND to a missing mailbox hints TRYCREATE');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('STORE (UNCHANGEDSINCE 0) leaves everything unchanged and lists it all in MODIFIED (RFC 7162 §3.1.3)', async () => {
  const { s, server, sock, cat } = await loggedIn((c) => {
    c.get('INBOX')!.append(Buffer.from('a'));
    c.get('INBOX')!.append(Buffer.from('b'));
  });
  try {
    await s.run('a1', 'SELECT INBOX');
    // Every message has MODSEQ >= 1 > 0, so UNCHANGEDSINCE 0 fails for all — none are stored.
    const resp = await s.run('a2', String.raw`STORE 1:2 (UNCHANGEDSINCE 0) +FLAGS (\Seen)`);
    assert.match(resp, /^a2 OK \[MODIFIED 1:2\]/m, 'all messages are listed in MODIFIED');
    assert.ok(!cat.get('INBOX')!.messages.some((m) => m.flags.has('\\Seen')), 'no flag was actually changed');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('AUTHENTICATE: cancel (*) is BAD; an unsupported mechanism is NO [CANNOT] (RFC 9051 §6.2.2)', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'u' && p === 'p' });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    await s.greeting();
    // Unsupported mechanism → NO [CANNOT].
    assert.match(await s.run('a1', 'AUTHENTICATE CRAM-MD5'), /^a1 NO \[CANNOT\]/m, 'an unsupported SASL mechanism is NO [CANNOT]');
    // Start PLAIN, then cancel with a bare "*" on the continuation → BAD.
    s.raw('a2 AUTHENTICATE PLAIN\r\n');
    await s.waitFor('+ ');
    s.raw('*\r\n');
    const cancelled = await s.waitFor('a2 ');
    assert.match(cancelled, /^a2 BAD/m, 'cancelling an AUTHENTICATE with * is BAD');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('ENABLE is rejected once a mailbox is selected (RFC 9051 §6.3.1)', async () => {
  const { s, server, sock } = await loggedIn();
  try {
    await s.run('a1', 'SELECT INBOX');
    assert.match(await s.run('a2', 'ENABLE IMAP4rev2'), /^a2 BAD/m, 'ENABLE with a mailbox selected is BAD');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('STATUS SIZE / DELETED and RFC822.SIZE carry the right VALUES (not just laziness)', async () => {
  const raw = Buffer.from('Subject: sized\r\n\r\nbody bytes here\r\n', 'latin1');
  const { s, server, sock } = await loggedIn((c) => {
    c.get('INBOX')!.append(raw);
    const uid = c.get('INBOX')!.append(Buffer.from('Subject: doomed\r\n\r\nx\r\n', 'latin1'));
    c.get('INBOX')!.storeFlags(uid, 'add', ['\\Deleted']);
  });
  try {
    await s.run('a1', 'SELECT INBOX');
    const status = await s.run('a2', 'STATUS INBOX (MESSAGES SIZE DELETED)');
    // SIZE is the summed octet count of both messages; DELETED counts the one \Deleted message.
    const total = raw.length + Buffer.from('Subject: doomed\r\n\r\nx\r\n', 'latin1').length;
    assert.match(status, new RegExp(`MESSAGES 2`), 'MESSAGES value');
    assert.match(status, new RegExp(`SIZE ${total}\\b`), 'SIZE is the exact summed octet count');
    assert.match(status, /DELETED 1\b/, 'DELETED counts the \\Deleted message');
    const fetched = await s.run('a3', 'FETCH 1 (RFC822.SIZE)');
    assert.match(fetched, new RegExp(`RFC822\\.SIZE ${raw.length}\\b`), 'RFC822.SIZE is the exact octet count');
  } finally {
    sock.destroy();
    await server.close();
  }
});
