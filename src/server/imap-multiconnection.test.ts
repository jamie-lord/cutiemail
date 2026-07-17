/**
 * Multi-connection mailbox synchronisation (RFC 9051 §7.4.1). Two clients on one
 * mailbox — a desktop and a phone, or two Thunderbird windows — must each learn what
 * the other did: a message one expunges vanishes for the other, and mail one files
 * appears for the other. The server may only renumber at a command boundary, never
 * mid-FETCH, so the untagged EXPUNGE/EXISTS land at NOOP/CHECK or, in real time,
 * during IDLE. This drives two live connections against one shared mailbox.
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
  /** Everything received so far, as a string. */
  get seen(): string {
    return this.#acc.toString('latin1');
  }
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (this.seen.includes(needle)) return this.seen;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(this.seen)}`);
  }
}

/** Open a logged-in session with INBOX selected. */
async function open(port: number): Promise<Session> {
  const s = new Session(net.connect(port, '127.0.0.1'));
  await s.waitFor('* OK');
  s.send('a1 LOGIN test pw\r\na2 SELECT INBOX\r\n');
  await s.waitFor('a2 OK');
  return s;
}

test('a message one connection expunges is announced to another at its next NOOP', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['one', 'two', 'three']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    // A deletes and expunges the middle message (sequence 2).
    a.send('c1 STORE 2 +FLAGS (\\Deleted)\r\n');
    await a.waitFor('c1 OK');
    a.send('c2 EXPUNGE\r\n');
    await a.waitFor('c2 OK');

    // B has been told nothing yet — it still believes there are three.
    assert.doesNotMatch(b.seen.slice(b.seen.indexOf('a2 OK')), /EXPUNGE/, 'B is not renumbered before it asks');

    // B polls with NOOP and now learns message 2 is gone.
    b.send('d1 NOOP\r\n');
    await b.waitFor('d1 OK');
    const news = b.seen.slice(b.seen.indexOf('a2 OK'));
    assert.match(news, /\* 2 EXPUNGE/, 'B sees the expunge of sequence 2 at NOOP');
    assert.doesNotMatch(news, /EXISTS/, 'a pure removal needs no EXISTS');

    // And B now agrees there are two messages: a UID FETCH of the survivors works,
    // and the expunged one is no longer addressable by its old sequence number.
    b.send('d2 FETCH 1:* (UID)\r\n');
    await b.waitFor('d2 OK');
    const fetched = b.seen.slice(b.seen.indexOf('d1 OK'));
    assert.match(fetched, /\* 1 FETCH/, 'survivor 1 is fetchable');
    assert.match(fetched, /\* 2 FETCH/, 'survivor 2 is fetchable');
    assert.doesNotMatch(fetched, /\* 3 FETCH/, 'there is no third message any more');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('an idling connection is told in real time when another connection expunges', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['one', 'two']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    b.send('b3 IDLE\r\n');
    await b.waitFor('+ idling');

    a.send('c1 STORE 1 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await a.waitFor('c2 OK');

    // The expunge reaches the idling connection without it polling.
    await b.waitFor('* 1 EXPUNGE');

    b.send('DONE\r\n');
    await b.waitFor('b3 OK');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('mail one connection files with APPEND appears for another (NOOP and IDLE)', async () => {
  const catalog = new MemoryCatalog();
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port); // INBOX starts empty
  const b = await open(server.port);
  try {
    // B is idling; A files a message with APPEND. B must see EXISTS in real time,
    // driven by the APPEND path's own notify (no inbound SMTP delivery involved).
    b.send('b3 IDLE\r\n');
    await b.waitFor('+ idling');
    a.send('c1 APPEND INBOX {18}\r\n');
    await a.waitFor('+');
    a.send('Subject: hi\r\n\r\nx\r\n\r\n'); // 18-byte literal, then the command-terminating CRLF
    await a.waitFor('c1 OK');
    await b.waitFor('* 1 EXISTS');
    b.send('DONE\r\n');
    await b.waitFor('b3 OK');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('a flag one connection sets is announced to another as an untagged FETCH', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['one', 'two']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    a.send('c1 STORE 2 +FLAGS (\\Flagged)\r\n');
    await a.waitFor('c1 OK');
    // B has not been told yet.
    assert.doesNotMatch(b.seen.slice(b.seen.indexOf('a2 OK')), /Flagged/, 'B is not told before it asks');
    b.send('d1 NOOP\r\n');
    await b.waitFor('d1 OK');
    const news = b.seen.slice(b.seen.indexOf('a2 OK'));
    assert.match(news, /\* 2 FETCH \(FLAGS \([^)]*\\Flagged[^)]*\) UID \d+\)/, 'B learns message 2 is now \\Flagged');
    // Asking again produces no duplicate — the change was reconciled once.
    const mark = b.seen.length;
    b.send('d2 NOOP\r\n');
    await b.waitFor('d2 OK');
    assert.doesNotMatch(b.seen.slice(mark), /FETCH/, 'the flag change is not re-announced on the next poll');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('a message another connection reads (\\Seen via BODY[] fetch) shows as read here', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  inbox.append(Buffer.from('Subject: unread\r\n\r\nbody\r\n', 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    b.send('b3 IDLE\r\n');
    await b.waitFor('+ idling');
    // A opens the message: a non-peek BODY[] fetch marks it \Seen as a side effect.
    a.send('c1 FETCH 1 (BODY[])\r\n');
    await a.waitFor('c1 OK');
    // The idling reader is told the message is now \Seen, in real time.
    await b.waitFor('FETCH (FLAGS (');
    const news = b.seen.slice(b.seen.indexOf('+ idling'));
    assert.match(news, /\\Seen/, 'the idling connection sees the message become \\Seen');
    b.send('DONE\r\n');
    await b.waitFor('b3 OK');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('EXPUNGE sequence numbers are descending so an earlier removal never invalidates a later one', async () => {
  // If a connection removes several messages, the peer must be able to apply the
  // EXPUNGEs top-to-bottom without recomputing: RFC 9051 §7.4.1 requires descending
  // sequence numbers. Delete 2 and 4 of five, then check the peer's view.
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['1', '2', '3', '4', '5']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    a.send('c1 STORE 2,4 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await a.waitFor('c2 OK');
    b.send('d1 NOOP\r\n');
    await b.waitFor('d1 OK');
    const news = b.seen.slice(b.seen.indexOf('a2 OK'));
    // Both are reported, and 4 comes before 2 (descending) so 2 stays valid.
    assert.match(news, /\* 4 EXPUNGE[\s\S]*\* 2 EXPUNGE/, 'EXPUNGEs are highest-sequence-first');
    const four = news.indexOf('* 4 EXPUNGE');
    const two = news.indexOf('* 2 EXPUNGE');
    assert.ok(four >= 0 && two > four, 'sequence 4 is expunged before sequence 2');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});
