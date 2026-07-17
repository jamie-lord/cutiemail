/**
 * QRESYNC (RFC 7162 §3.2). The quick-resynchronization extension a phone client uses
 * to reconnect fast: it hands back the UIDVALIDITY and mod-sequence it last saw, and
 * the server replays — in one round-trip — which of its cached UIDs vanished
 * (VANISHED EARLIER) and which messages' flags changed, instead of the client
 * refetching the whole mailbox. This drives that path plus the VANISHED FETCH modifier
 * against a live server.
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
      const s = this.seen;
      const idx = s.indexOf(`${tag} `, from);
      if (idx >= 0 && /\r\n/.test(s.slice(idx))) return s.slice(from);
      await delay(5);
    }
    throw new Error(`timeout on ${tag} ${cmd}`);
  }
  async waitFor(needle: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (this.seen.includes(needle)) return;
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
  await s.run('a2', 'ENABLE QRESYNC');
  return s;
}

test('CAPABILITY advertises QRESYNC and ENABLE QRESYNC is accepted', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    assert.match(s.seen, /QRESYNC/, 'QRESYNC in the greeting capability');
    await s.run('a1', 'LOGIN test pw');
    const en = await s.run('a2', 'ENABLE QRESYNC');
    assert.match(en, /\* ENABLED[^\r]*QRESYNC/, 'ENABLE echoes QRESYNC');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('SELECT (QRESYNC ...) replays VANISHED and changed flags since the client mod-sequence', async () => {
  const catalog = catalogWith(3); // UIDs 1,2,3; UIDVALIDITY 1
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier: new MailboxNotifier() });
  const setup = await login(server.port);
  try {
    // Learn the mod-sequence the client would have cached at first sync.
    const sel = await setup.run('a3', 'SELECT INBOX (CONDSTORE)');
    const base = Number(/HIGHESTMODSEQ (\d+)/.exec(sel)![1]);
    // Now the mailbox changes: UID 2 is expunged, UID 1 is re-flagged.
    await setup.run('a4', 'UID STORE 2 +FLAGS (\\Deleted)');
    await setup.run('a5', 'EXPUNGE');
    await setup.run('a6', 'UID STORE 1 +FLAGS (\\Flagged)');

    // A fresh client reconnects with QRESYNC, presenting (UIDVALIDITY base-modseq).
    const client = new Session(net.connect(server.port, '127.0.0.1'));
    await client.waitFor('* OK');
    await client.run('b1', 'LOGIN test pw');
    await client.run('b2', 'ENABLE QRESYNC');
    const resync = await client.run('b3', `SELECT INBOX (QRESYNC (1 ${base}))`);
    // UID 2 vanished since `base`; UID 1's flags changed; UID 3 is unchanged.
    assert.match(resync, /\* VANISHED \(EARLIER\) 2/, 'the expunged UID is reported as VANISHED (EARLIER)');
    assert.match(resync, /FETCH \(UID 1 FLAGS \([^)]*\\Flagged[^)]*\) MODSEQ \(\d+\)\)/, 'the re-flagged message is replayed with MODSEQ');
    assert.doesNotMatch(resync, /UID 3 /, 'the unchanged message is not replayed');
    client.sock.destroy();
  } finally {
    setup.sock.destroy();
    await server.close();
  }
});

test('UID FETCH (CHANGEDSINCE n VANISHED) reports expunged UIDs in the set', async () => {
  const catalog = catalogWith(3);
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const s = await login(server.port);
  try {
    const sel = await s.run('a3', 'SELECT INBOX (CONDSTORE)');
    const base = Number(/HIGHESTMODSEQ (\d+)/.exec(sel)![1]);
    await s.run('a4', 'UID STORE 3 +FLAGS (\\Deleted)');
    await s.run('a5', 'EXPUNGE'); // UID 3 gone
    const m = s.mark();
    const fetch = await s.run('a6', `UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${base} VANISHED)`);
    const body = s.seen.slice(m);
    assert.match(body, /\* VANISHED \(EARLIER\) 3/, 'the expunged UID in the set is reported as VANISHED');
    assert.match(fetch, /a6 OK/, 'the fetch completes');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('a QRESYNC-enabled session receives VANISHED, not EXPUNGE, for a real-time peer expunge', async () => {
  // RFC 7162 §3.2.4: once QRESYNC is enabled the server uses VANISHED to report
  // expunges, not the EXPUNGE response. A desktop with QRESYNC on, idling, must be told
  // VANISHED when the phone expunges a message.
  const catalog = catalogWith(3);
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier: new MailboxNotifier() });
  const a = await login(server.port); // QRESYNC enabled
  const b = await login(server.port);
  try {
    await a.run('a3', 'SELECT INBOX');
    await b.run('b3', 'SELECT INBOX');
    const mark = a.mark();
    a.send('a4 IDLE\r\n');
    await a.waitFor('+ idling');
    // B expunges UID 2.
    await b.run('b4', 'UID STORE 2 +FLAGS (\\Deleted)');
    await b.run('b5', 'EXPUNGE');
    await a.waitFor('VANISHED');
    const news = a.seen.slice(mark);
    assert.match(news, /\* VANISHED 2/, 'the QRESYNC session is told VANISHED 2');
    assert.doesNotMatch(news.replace(/\(EARLIER\)/g, ''), /\* \d+ EXPUNGE/, 'and NOT an EXPUNGE response');
    a.send('DONE\r\n');
    await a.waitFor('a4 OK');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('SELECT (QRESYNC ...) without ENABLE QRESYNC is a tagged BAD (RFC 7162 §3.2.5)', async () => {
  const server = await ImapServer.start(catalogWith(2), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    await s.run('a1', 'LOGIN test pw'); // note: no ENABLE QRESYNC
    const resp = await s.run('a2', 'SELECT INBOX (QRESYNC (1 1))');
    assert.match(resp, /a2 BAD/, 'the QRESYNC parameter is rejected without ENABLE');
    assert.doesNotMatch(resp, /EXISTS/, 'and the mailbox is not selected');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('SELECT (CONDSTORE QRESYNC ...) — QRESYNC after another param still replays (regex not anchored)', async () => {
  const catalog = catalogWith(3);
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const s = await login(server.port);
  try {
    const sel = await s.run('a3', 'SELECT INBOX (CONDSTORE)');
    const base = Number(/HIGHESTMODSEQ (\d+)/.exec(sel)![1]);
    await s.run('a4', 'UID STORE 2 +FLAGS (\\Deleted)');
    await s.run('a5', 'EXPUNGE');
    // QRESYNC is the SECOND select-param here.
    const resync = await s.run('a6', `SELECT INBOX (CONDSTORE QRESYNC (1 ${base}))`);
    assert.match(resync, /\* VANISHED \(EARLIER\) 2/, 'the QRESYNC replay fires even when it is not the first param');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('FETCH VANISHED misuse (non-UID, or no CHANGEDSINCE) is a tagged BAD (RFC 7162 §3.2.6)', async () => {
  const server = await ImapServer.start(catalogWith(2), { authenticate: () => true });
  const s = await login(server.port);
  try {
    await s.run('a3', 'SELECT INBOX (CONDSTORE)');
    // Non-UID FETCH with VANISHED.
    const bad1 = await s.run('a4', 'FETCH 1:* (FLAGS) (CHANGEDSINCE 1 VANISHED)');
    assert.match(bad1, /a4 BAD/, 'VANISHED on a non-UID FETCH is rejected');
    // UID FETCH with VANISHED but no CHANGEDSINCE.
    const bad2 = await s.run('a5', 'UID FETCH 1:* (FLAGS) (VANISHED)');
    assert.match(bad2, /a5 BAD/, 'VANISHED without CHANGEDSINCE is rejected');
    // The connection is still usable.
    await s.run('a6', 'NOOP');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('SELECT (QRESYNC ...) with a stale UIDVALIDITY does not replay (client must full-resync)', async () => {
  const catalog = catalogWith(2);
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const s = await login(server.port);
  try {
    // Present a UIDVALIDITY (999) that does not match the mailbox's (1).
    const resync = await s.run('a3', 'SELECT INBOX (QRESYNC (999 1))');
    assert.doesNotMatch(resync, /VANISHED/, 'no VANISHED replay when the client UIDs are from a different UIDVALIDITY');
    assert.match(resync, /a3 OK/, 'the SELECT still succeeds normally');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});
