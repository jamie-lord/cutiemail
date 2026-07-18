/**
 * IMAP SEARCH criteria parsing, including quoted multi-word values. A plain
 * split(' ') on the criteria breaks a quoted phrase into words and searches only
 * the first — so SEARCH SUBJECT "annual report" silently matched anything with
 * "annual". This pins the quote-aware tokenisation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class S {
  #acc = '';
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d) => (this.#acc += d.toString('latin1')));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  /** Send a SEARCH and return the untagged `* SEARCH ...` result numbers. */
  async search(tag: string, criteria: string): Promise<number[]> {
    const from = this.#acc.length;
    this.send(`${tag} SEARCH ${criteria}\r\n`);
    for (let i = 0; i < 400; i++) {
      const seg = this.#acc.slice(from);
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(seg)) {
        const line = seg.split('\r\n').find((l) => l.startsWith('* SEARCH')) ?? '* SEARCH';
        return line
          .replace('* SEARCH', '')
          .trim()
          .split(/\s+/)
          .filter((x) => x.length > 0)
          .map(Number);
      }
      await delay(5);
    }
    throw new Error(`timed out on ${tag}`);
  }
  async ready(needle: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (this.#acc.includes(needle)) return;
      await delay(5);
    }
    throw new Error(`timed out on ${needle}`);
  }
  snapshot(): string {
    return this.#acc;
  }
}

test('SEARCH SUBJECT with a quoted multi-word phrase matches the whole phrase', async () => {
  const cat = new MemoryCatalog();
  const inbox = cat.get('INBOX')!;
  inbox.append(Buffer.from('From: a@x.test\r\nSubject: Meeting notes\r\n\r\nb\r\n', 'latin1')); // 1
  inbox.append(Buffer.from('From: b@y.test\r\nSubject: annual report draft\r\n\r\nb\r\n', 'latin1')); // 2
  inbox.append(Buffer.from('From: c@z.test\r\nSubject: the annual meeting\r\n\r\nb\r\n', 'latin1')); // 3

  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await s.ready('a2 OK');

    assert.deepEqual(await s.search('a3', 'SUBJECT "annual report"'), [2], 'the phrase matches only the message containing it');
    assert.deepEqual(await s.search('a4', 'SUBJECT "no such phrase"'), [], 'a phrase present nowhere matches nothing');
    assert.deepEqual(await s.search('a5', 'SUBJECT annual'), [2, 3], 'a bare word still matches as a substring');
    assert.deepEqual(await s.search('a6', 'FROM a@x.test SUBJECT "Meeting notes"'), [1], 'combined FROM + quoted SUBJECT');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('SEARCH rejects an over-long key list instead of doing O(keys×messages) work (run-5 DoS bound)', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('From: a@x.test\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await s.ready('a2 OK');
    // 64 keys (the cap) is accepted; 65 is rejected as malformed BEFORE any per-message scan,
    // so a client cannot force O(keys × messages × size) work that freezes the whole server.
    s.send(`a3 SEARCH ${Array.from({ length: 64 }, () => 'TEXT a').join(' ')}\r\n`);
    await s.ready('a3 OK');
    s.send(`a4 SEARCH ${Array.from({ length: 65 }, () => 'TEXT a').join(' ')}\r\n`);
    await s.ready('a4 BAD'); // ready() throws on timeout, so reaching here proves the rejection
    assert.match(s.snapshot().slice(s.snapshot().lastIndexOf('a4 ')), /^a4 BAD/m);
    // The cap must also count through OR/NOT recursion: a deeply nested single top-level key
    // with hundreds of TEXT leaves would otherwise bypass the top-level count (run-6).
    s.send(`a5 SEARCH ${Array.from({ length: 300 }, () => 'OR TEXT a').join(' ')} TEXT a\r\n`);
    await s.ready('a5 BAD');
    assert.match(s.snapshot().slice(s.snapshot().lastIndexOf('a5 ')), /^a5 BAD/m);
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('SEARCH NOT / dates / size / OR are executed, not silently dropped', async () => {
  const cat = new MemoryCatalog();
  const inbox = cat.get('INBOX')!;
  inbox.append(Buffer.from('From: alice@x.test\r\nSubject: old note\r\n\r\nhello world\r\n', 'latin1'), [], Date.UTC(2024, 0, 1)); // 1: unseen, old, small
  inbox.append(Buffer.from(`From: bob@y.test\r\nSubject: big recent\r\n\r\n${'x'.repeat(5000)}\r\n`, 'latin1'), ['\\Seen'], Date.UTC(2026, 5, 1)); // 2: seen, recent, large

  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await s.ready('a2 OK');

    // The regression: NOT must invert, not be dropped (which returned the SEEN message).
    assert.deepEqual(await s.search('a3', 'NOT SEEN'), [1], 'NOT SEEN matches only the unseen message');
    assert.deepEqual(await s.search('a4', 'SINCE 1-Jan-2025'), [2], 'SINCE filters by internal date');
    assert.deepEqual(await s.search('a5', 'BEFORE 1-Jan-2025'), [1], 'BEFORE filters by internal date');
    assert.deepEqual(await s.search('a6', 'LARGER 1000'), [2], 'LARGER filters by size');
    assert.deepEqual(await s.search('a7', 'SMALLER 1000'), [1], 'SMALLER filters by size');
    assert.deepEqual(await s.search('a8', 'BODY "hello"'), [1], 'BODY searches the body text');
    assert.deepEqual(await s.search('a9', 'OR FROM alice FROM bob'), [1, 2], 'OR unions the two senders');
    assert.deepEqual(await s.search('b1', 'SEEN LARGER 1000'), [2], 'compound keys are ANDed');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('SEARCH with an unsupported key is rejected with BAD, not answered with wrong results', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await s.ready('a2 OK');
    s.send('a3 SEARCH FROBNICATE something\r\n');
    await s.ready('a3 BAD');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('extended SEARCH RETURN yields an ESEARCH aggregate (RFC 9051 §7.3.4)', async () => {
  const cat = new MemoryCatalog();
  const inbox = cat.get('INBOX')!;
  for (let i = 0; i < 6; i++) inbox.append(Buffer.from(`Subject: m${i}\r\n\r\nb\r\n`, 'latin1'));
  inbox.storeFlags(2, 'add', ['\\Seen']);
  inbox.storeFlags(3, 'add', ['\\Seen']);
  inbox.storeFlags(4, 'add', ['\\Seen']); // SEEN = 2,3,4 ; UNSEEN = 1,5,6
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await s.ready('a2 OK');
    s.send('a3 SEARCH RETURN (MIN MAX COUNT) SEEN\r\n');
    await s.ready('a3 OK');
    assert.match(s.snapshot(), /\* ESEARCH \(TAG "a3"\) MIN 2 MAX 4 COUNT 3/, 'aggregates over the SEEN set');
    s.send('a4 SEARCH RETURN (ALL) UNSEEN\r\n');
    await s.ready('a4 OK');
    assert.match(s.snapshot(), /\* ESEARCH \(TAG "a4"\) ALL 1,5:6/, 'ALL is a compressed sequence-set');
    s.send('a5 UID SEARCH RETURN (COUNT) UNSEEN\r\n');
    await s.ready('a5 OK');
    assert.match(s.snapshot(), /\* ESEARCH \(TAG "a5"\) UID COUNT 3/, 'UID mode is flagged in the ESEARCH reply');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('mailbox names with spaces (Outlook-style) work through CREATE/SELECT/STATUS/LIST', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\n');
    await s.ready('a1 OK');
    s.send('a2 CREATE "Sent Items"\r\n');
    await s.ready('a2 OK');
    assert.ok(cat.get('Sent Items') !== undefined, 'the full spaced name was created, not truncated');
    assert.equal(cat.get('Sent'), undefined, 'not truncated to the first word');
    s.send('a3 SELECT "Sent Items"\r\n');
    await s.ready('a3 OK');
    s.send('a4 STATUS "Sent Items" (MESSAGES)\r\n');
    await s.ready('* STATUS "Sent Items" (MESSAGES 0)');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('extended LIST forms (RFC 9051 §6.3.9): (SUBSCRIBED) selection and RETURN options', async () => {
  const cat = new MemoryCatalog();
  cat.create('Sent');
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new S(sock);
  try {
    await s.ready('* OK');
    s.send('a1 LOGIN u p\r\n');
    await s.ready('a1 OK');
    // The regression: a leading (SUBSCRIBED) must not swallow the pattern — folders
    // must still be listed (with \Subscribed), not just the delimiter line.
    s.send('a2 LIST (SUBSCRIBED) "" *\r\n');
    await s.ready('a2 OK');
    const sub = s.snapshot();
    assert.match(sub, /\* LIST \([^)]*\\Subscribed\) "\/" INBOX/, '(SUBSCRIBED) lists INBOX with the \\Subscribed attribute');
    assert.match(sub, /\* LIST \([^)]*\\Subscribed\) "\/" Sent/, '(SUBSCRIBED) lists Sent too — the pattern was not swallowed');

    s.send('a3 LIST "" * RETURN (SPECIAL-USE)\r\n');
    await s.ready('a3 OK');
    // The RETURN clause is ignored; the plain folder list still comes back.
    const ret = s.snapshot();
    assert.match(ret, /a3 OK/, 'RETURN options are accepted');
    assert.ok(ret.includes('"/" Sent'), 'the pattern still matched with a RETURN clause present');
  } finally {
    sock.destroy();
    await server.close();
  }
});
