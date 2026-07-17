/**
 * CONDSTORE (RFC 7162). A reconnecting client resyncs efficiently by tracking each
 * message's mod-sequence: it asks "what changed since MODSEQ n?" instead of refetching
 * everything, and guards a flag change with UNCHANGEDSINCE so it never clobbers a
 * change another client made first. This drives the wire surface: the capability, the
 * HIGHESTMODSEQ on SELECT, FETCH MODSEQ / CHANGEDSINCE, STORE UNCHANGEDSINCE + MODIFIED,
 * and STATUS HIGHESTMODSEQ — against a live server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  get seen(): string {
    return this.#acc.toString('latin1');
  }
  mark(): number {
    return this.#acc.length;
  }
  async run(tag: string, cmd: string): Promise<string> {
    const from = this.mark();
    this.send(`${tag} ${cmd}\r\n`);
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      const idx = s.indexOf(`${tag} `, from);
      if (idx >= 0 && /\r\n/.test(s.slice(idx))) return s.slice(from);
      await delay(5);
    }
    throw new Error(`timeout on ${tag} ${cmd}: ${JSON.stringify(this.#acc.toString('latin1').slice(from))}`);
  }
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (this.seen.includes(needle)) return this.seen;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

function catalogWith(n: number): MemoryCatalog {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (let i = 0; i < n; i++) inbox.append(Buffer.from(`Subject: m${i}\r\n\r\nx\r\n`, 'latin1'));
  return catalog;
}

async function login(port: number): Promise<Session> {
  const s = new Session(net.connect(port, '127.0.0.1'));
  await s.waitFor('* OK');
  await s.run('a1', 'LOGIN test pw');
  return s;
}

test('CAPABILITY advertises CONDSTORE', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    const g = await s.waitFor('* OK');
    assert.match(g, /CONDSTORE/, 'CONDSTORE in the greeting capability');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('every SELECT reports HIGHESTMODSEQ (RFC 7162 §3.1.2.2), but MODSEQ in FETCH stays gated on enabling', async () => {
  const server = await ImapServer.start(catalogWith(2), { authenticate: () => true });
  const s = await login(server.port);
  try {
    // A CONDSTORE server MUST send HIGHESTMODSEQ on a plain SELECT too — it is how a
    // client discovers mod-sequence support without enabling.
    const plain = await s.run('a2', 'SELECT INBOX');
    assert.match(plain, /\* OK \[HIGHESTMODSEQ \d+\]/, 'a plain SELECT still reports HIGHESTMODSEQ');
    // But until CONDSTORE is enabled, a FETCH must NOT carry MODSEQ.
    const f = await s.run('a3', 'FETCH 1 (FLAGS)');
    assert.doesNotMatch(f, /MODSEQ/, 'MODSEQ is not sent to a session that has not enabled CONDSTORE');
    // SELECT (CONDSTORE) also reports it, and enables MODSEQ for subsequent FETCH.
    const cond = await s.run('a4', 'SELECT INBOX (CONDSTORE)');
    assert.match(cond, /\* OK \[HIGHESTMODSEQ \d+\]/, 'SELECT (CONDSTORE) reports HIGHESTMODSEQ');
    const f2 = await s.run('a5', 'FETCH 1 (FLAGS)');
    assert.match(f2, /MODSEQ \(\d+\)/, 'once enabled, FETCH carries MODSEQ');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('once CONDSTORE is enabled, FETCH carries MODSEQ; MODSEQ can be requested explicitly', async () => {
  const server = await ImapServer.start(catalogWith(1), { authenticate: () => true });
  const s = await login(server.port);
  try {
    // Explicit request enables CONDSTORE even without SELECT (CONDSTORE).
    await s.run('a2', 'SELECT INBOX');
    const f = await s.run('a3', 'FETCH 1 (FLAGS MODSEQ)');
    assert.match(f, /\* 1 FETCH \(.*MODSEQ \(\d+\)/, 'the MODSEQ data item is returned');
    // Now that it is enabled, a plain FETCH also includes MODSEQ (RFC 7162 §3.1.4.1).
    const f2 = await s.run('a4', 'FETCH 1 (FLAGS)');
    assert.match(f2, /MODSEQ \(\d+\)/, 'MODSEQ is now included in every FETCH');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('FETCH (CHANGEDSINCE n) returns only messages modified after n', async () => {
  const server = await ImapServer.start(catalogWith(2), { authenticate: () => true });
  const s = await login(server.port);
  try {
    await s.run('a2', 'SELECT INBOX (CONDSTORE)');
    // Bump message 1's mod-sequence above message 2's.
    await s.run('a3', 'STORE 1 +FLAGS (\\Seen)');
    const base = s.mark();
    const changed = await s.run('a4', 'FETCH 1:* (FLAGS) (CHANGEDSINCE 3)');
    const body = s.seen.slice(base);
    assert.match(body, /\* 1 FETCH/, 'message 1 (changed) is returned');
    assert.doesNotMatch(body, /\* 2 FETCH/, 'message 2 (unchanged since 3) is filtered out');
    assert.match(changed, /a4 OK/, 'the fetch completes');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('STORE (UNCHANGEDSINCE n) applies to unchanged messages and rejects changed ones with MODIFIED', async () => {
  const server = await ImapServer.start(catalogWith(1), { authenticate: () => true });
  const s = await login(server.port);
  try {
    await s.run('a2', 'SELECT INBOX (CONDSTORE)'); // HIGHESTMODSEQ 2, message 1 modseq 2
    // Guard succeeds: message 1 (modseq 2) is unchanged since 2, so the flag is set.
    const ok = await s.run('a3', 'STORE 1 (UNCHANGEDSINCE 2) +FLAGS (\\Seen)');
    assert.doesNotMatch(ok, /MODIFIED/, 'the conditional store succeeds');
    assert.match(ok, /\* 1 FETCH \(.*MODSEQ \(\d+\)/, 'the new MODSEQ is echoed even to a non-SILENT store');
    // Guard fails: message 1 has now moved past mod-sequence 2, so a second guard at 2
    // must NOT apply and must name the message in MODIFIED.
    const rejected = await s.run('a4', 'STORE 1 (UNCHANGEDSINCE 2) +FLAGS (\\Answered)');
    assert.match(rejected, /a4 OK \[MODIFIED 1\]/, 'the stale conditional store is rejected via MODIFIED');
    // Prove it did NOT apply: \Answered must be absent.
    const f = await s.run('a5', 'FETCH 1 (FLAGS)');
    assert.doesNotMatch(f, /\\Answered/, 'the rejected flag change was not applied');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('a CONDSTORE-enabled connection sees MODSEQ in a peer flag change pushed during IDLE', async () => {
  // The full phone+desktop case: desktop (A) has CONDSTORE on and is idling; the phone
  // (B) flags a message; A must be told as an untagged FETCH carrying the new MODSEQ, so
  // A can advance its own sync state without a HIGHESTMODSEQ round-trip.
  const catalog = catalogWith(1);
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier: new MailboxNotifier() });
  const a = await login(server.port);
  const b = await login(server.port);
  try {
    await a.run('a2', 'SELECT INBOX (CONDSTORE)');
    await b.run('b2', 'SELECT INBOX');
    const base = a.mark();
    a.send('a3 IDLE\r\n');
    await a.waitFor('+ idling');
    await b.run('b3', 'STORE 1 +FLAGS (\\Flagged)');
    await a.waitFor('MODSEQ (');
    const pushed = a.seen.slice(base);
    assert.match(pushed, /\* 1 FETCH \(FLAGS \([^)]*\\Flagged[^)]*\) MODSEQ \(\d+\) UID \d+\)/, 'the idling CONDSTORE client sees FLAGS + MODSEQ + UID');
    a.send('DONE\r\n');
    await a.waitFor('a3 OK');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('SEARCH MODSEQ n returns messages at or above n and reports the highest match', async () => {
  const server = await ImapServer.start(catalogWith(2), { authenticate: () => true });
  const s = await login(server.port);
  try {
    await s.run('a2', 'SELECT INBOX (CONDSTORE)'); // msg1 modseq 2, msg2 modseq 3
    await s.run('a3', 'STORE 1 +FLAGS (\\Seen)'); // msg1 now modseq 4 (highest)
    const base = s.mark();
    const res = await s.run('a4', 'SEARCH MODSEQ 4');
    const body = s.seen.slice(base);
    // Only message 1 (modseq 4) is >= 4; the SEARCH line carries the highest match modseq.
    assert.match(body, /\* SEARCH 1 \(MODSEQ 4\)/, 'SEARCH MODSEQ returns the match and the highest mod-sequence');
    assert.match(res, /a4 OK/, 'the search completes');
    // A MODSEQ search with no matches returns a bare SEARCH line with no MODSEQ element.
    const base2 = s.mark();
    await s.run('a5', 'SEARCH MODSEQ 9999');
    const empty = s.seen.slice(base2);
    assert.match(empty, /\* SEARCH\r\n/, 'no matches → a bare SEARCH line, no MODSEQ element');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('UID STORE (UNCHANGEDSINCE n) parses correctly and reports MODIFIED by UID', async () => {
  // Real clients address STORE by UID, and the UID prefix shifts the positional args —
  // the (UNCHANGEDSINCE n) modifier must still be found and MODIFIED must list UIDs.
  const server = await ImapServer.start(catalogWith(1), { authenticate: () => true });
  const s = await login(server.port);
  try {
    await s.run('a2', 'SELECT INBOX (CONDSTORE)'); // message UID 1, modseq 2
    // Succeeds and echoes the new MODSEQ, keyed by UID.
    const ok = await s.run('a3', 'UID STORE 1 (UNCHANGEDSINCE 2) +FLAGS (\\Seen)');
    assert.match(ok, /\* 1 FETCH \(.*MODSEQ \(\d+\).*UID 1\)/, 'the UID STORE echoes FLAGS+MODSEQ+UID');
    assert.doesNotMatch(ok, /MODIFIED/, 'the fresh guard succeeds');
    // Now stale: the guard at 2 fails and MODIFIED must name the UID (1), not a seq.
    const rejected = await s.run('a4', 'UID STORE 1 (UNCHANGEDSINCE 2) +FLAGS (\\Answered)');
    assert.match(rejected, /a4 OK \[MODIFIED 1\]/, 'MODIFIED lists the UID of the unchanged-guard failure');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('STATUS HIGHESTMODSEQ reports the mailbox mod-sequence and it advances on a flag change', async () => {
  const catalog = catalogWith(1);
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier: new MailboxNotifier() });
  const s = await login(server.port);
  try {
    const st1 = await s.run('a2', 'STATUS INBOX (HIGHESTMODSEQ)');
    const m1 = /HIGHESTMODSEQ (\d+)/.exec(st1);
    assert.ok(m1, 'HIGHESTMODSEQ is reported');
    await s.run('a3', 'SELECT INBOX');
    await s.run('a4', 'STORE 1 +FLAGS (\\Flagged)');
    const st2 = await s.run('a5', 'STATUS INBOX (HIGHESTMODSEQ)');
    const m2 = /HIGHESTMODSEQ (\d+)/.exec(st2);
    assert.ok(m2 && Number(m2[1]) > Number(m1![1]), 'a flag change advances HIGHESTMODSEQ');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});
