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

test('a peer expunge is not swallowed when this connection then runs its own EXPUNGE', async () => {
  // Regression: the EXPUNGE handler used to reset its view to the live mailbox, erasing
  // an as-yet-unannounced peer removal — desyncing the client permanently. The peer's
  // removal must be announced (EXPUNGE responses are allowed during an EXPUNGE command).
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['one', 'two', 'three']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    // B removes message 1; A is not idling, so it has not heard about it yet.
    b.send('c1 STORE 1 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await b.waitFor('c2 OK');

    // A runs its own EXPUNGE (nothing of A's is \Deleted). A must still be told that
    // message 1 vanished — either here or at the following NOOP — never silently dropped.
    const mark = a.seen.length;
    a.send('d1 EXPUNGE\r\nd2 NOOP\r\n');
    await a.waitFor('d2 OK');
    const news = a.seen.slice(mark);
    assert.match(news, /\* 1 EXPUNGE/, 'A learns message 1 was expunged by the peer');

    // And A now agrees there are two messages, not three.
    a.send('d3 FETCH 1:* (UID)\r\n');
    await a.waitFor('d3 OK');
    const fetched = a.seen.slice(a.seen.indexOf('d2 OK'));
    assert.doesNotMatch(fetched, /\* 3 FETCH/, "A's view is two messages, not a phantom third");
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('a peer expunge is not swallowed when this connection then runs its own MOVE', async () => {
  // The MOVE branch of the same fix: MOVE resets the connection's view after removing
  // the moved messages, so it too must reconcile the peer's removal first.
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['one', 'two', 'three']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  catalog.create('Archive');
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    // B removes message 1 (UID 1); A is not idling.
    b.send('c1 STORE 1 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await b.waitFor('c2 OK');

    // A moves its own message by UID (unambiguous), then must still learn UID 1 vanished.
    const mark = a.seen.length;
    a.send('d1 UID MOVE 3 Archive\r\n');
    await a.waitFor('d1 OK');
    const news = a.seen.slice(mark);
    assert.match(news, /\* 1 EXPUNGE/, 'the peer removal is announced before/around the MOVE, not swallowed');

    // A now agrees INBOX has one message left (UID 2), and Archive received UID 3.
    a.send('d2 NOOP\r\nd3 FETCH 1:* (UID)\r\n');
    await a.waitFor('d3 OK');
    const view = a.seen.slice(a.seen.indexOf('d1 OK'));
    assert.doesNotMatch(view, /\* 2 FETCH/, "A's INBOX view is a single message, no phantom");
    assert.equal(catalog.get('Archive')!.messages.length, 1, 'the moved message landed in Archive');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('CLOSE expunges silently for the closer but still tells a peer the messages vanished', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (const subj of ['keep', 'drop']) inbox.append(Buffer.from(`Subject: ${subj}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    b.send('b3 IDLE\r\n');
    await b.waitFor('+ idling');
    // A deletes message 2 and CLOSEs; CLOSE expunges without sending A any EXPUNGE...
    a.send('c1 STORE 2 +FLAGS (\\Deleted)\r\nc2 CLOSE\r\n');
    await a.waitFor('c2 OK');
    const aSeen = a.seen.slice(a.seen.indexOf('c1 '));
    assert.doesNotMatch(aSeen, /EXPUNGE/, 'CLOSE does not send the closer an EXPUNGE (RFC 9051 §6.4.2)');
    // ...but the idling peer is told message 2 is gone.
    await b.waitFor('* 2 EXPUNGE');
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

test('a peer expunge does not renumber a bare-sequence FETCH before the client is told (RFC 9051 §7.4.1)', async () => {
  // The violation Dovecot's imaptest caught: connection B, which selected five
  // messages, must keep seeing sequence N -> the SAME message until it is sent the
  // EXPUNGE — even if a peer expunged something. Before the fix, B's `FETCH 2` after
  // A expunged UID 2 returned UID 3 (silently renumbered), so a sequence-based client
  // would read/modify the wrong message under concurrency.
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (let i = 1; i <= 5; i++) inbox.append(Buffer.from(`Subject: m${i}\r\n\r\nbody ${i}\r\n`, 'latin1')); // UIDs 1..5
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    // A expunges UID 2 (sequence 2).
    a.send('c1 STORE 2 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await a.waitFor('c2 OK');

    // B, with no intervening boundary, fetches its whole known range by sequence.
    // Its numbering must be unchanged: seq 1->UID1, seq 3->UID3, seq 4->UID4,
    // seq 5->UID5, and seq 2 (the message it knew there, now peer-expunged) is
    // OMITTED — never answered with UID 3.
    b.send('d1 FETCH 1:5 (UID)\r\n');
    await b.waitFor('d1 OK');
    // B's stream from its SELECT to the FETCH's tagged OK holds only this FETCH's
    // untagged responses (SELECT emits no FETCH; A's store was on another connection).
    const fetchWin = b.seen.slice(b.seen.indexOf('a2 OK'), b.seen.indexOf('d1 OK'));
    assert.doesNotMatch(fetchWin, /EXPUNGE/, 'no EXPUNGE is sent during the FETCH (§7.4.1)');
    assert.match(fetchWin, /\* 1 FETCH \(UID 1\)/, 'seq 1 stays UID 1');
    assert.match(fetchWin, /\* 3 FETCH \(UID 3\)/, 'seq 3 stays UID 3 (not shifted down to 2)');
    assert.match(fetchWin, /\* 4 FETCH \(UID 4\)/, 'seq 4 stays UID 4');
    assert.match(fetchWin, /\* 5 FETCH \(UID 5\)/, 'seq 5 is still present (not lost to renumbering)');
    assert.doesNotMatch(fetchWin, /\* 2 FETCH/, 'seq 2 (peer-expunged) is omitted, never renumbered to another UID');

    // The expunge surfaces only at the next boundary, and only then does B renumber.
    b.send('d2 NOOP\r\n');
    await b.waitFor('d2 OK');
    assert.match(b.seen.slice(b.seen.indexOf('d1 OK')), /\* 2 EXPUNGE/, 'the EXPUNGE lands at the NOOP boundary');
    b.send('d3 FETCH 1:* (UID)\r\n');
    await b.waitFor('d3 OK');
    const after = b.seen.slice(b.seen.indexOf('d2 OK'));
    assert.match(after, /\* 2 FETCH \(UID 3\)/, 'after acknowledging the expunge, seq 2 is now UID 3');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('a peer expunge does not renumber SEARCH results before the client is told (RFC 9051 §7.4.1)', async () => {
  // The SEARCH sibling of the FETCH renumbering bug: sequence numbers SEARCH returns
  // must be the client's known numbering, not the live post-expunge numbering.
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (let i = 1; i <= 5; i++) inbox.append(Buffer.from(`Subject: m${i}\r\n\r\nx\r\n`, 'latin1'));
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const a = await open(server.port);
  const b = await open(server.port);
  try {
    a.send('c1 STORE 2 +FLAGS (\\Deleted)\r\nc2 EXPUNGE\r\n');
    await a.waitFor('c2 OK');
    // B searches everything; results are its known sequence numbers 1,3,4,5 (seq 2
    // omitted), NOT the live 1,2,3,4 that a renumbering server would report.
    b.send('d1 SEARCH ALL\r\n');
    await b.waitFor('d1 OK');
    const line = b.seen.slice(b.seen.indexOf('a2 OK')).split('\r\n').find((l) => l.startsWith('* SEARCH')) ?? '';
    assert.equal(line.trim(), '* SEARCH 1 3 4 5', 'SEARCH reports the client-view sequence numbers');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});
