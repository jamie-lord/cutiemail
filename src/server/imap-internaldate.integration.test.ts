/**
 * INTERNALDATE and the FETCH macros (RFC 9051 §6.4.5, §6.3.12).
 *
 * The FAST/ALL/FULL macros are how a client populates a message list in one
 * round-trip, and every one of them includes INTERNALDATE — so an unexpanded macro
 * (or a missing INTERNALDATE) leaves the client without dates and sizes. This pins:
 * the macros expand, INTERNALDATE is returned in the "dd-Mon-yyyy HH:MM:SS +0000"
 * form, an APPENDed date is preserved (mail restore), and COPY keeps it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class C {
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
  async until(tag: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(this.#acc)) {
        const seg = this.#acc;
        this.#acc = '';
        return seg;
      }
      await delay(5);
    }
    throw new Error(`timed out on ${tag}: ${this.#acc}`);
  }
}

test('FETCH FAST and ALL expand to include INTERNALDATE (and SIZE, ENVELOPE)', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('From: a@x.test\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1'), [], Date.UTC(2025, 0, 15, 9, 30, 0));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = new C(net.connect(server.port, '127.0.0.1'));
  try {
    c.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await c.until('a2');
    c.send('a3 FETCH 1 FAST\r\n');
    const fast = await c.until('a3');
    assert.match(fast, /INTERNALDATE "15-Jan-2025 09:30:00 \+0000"/, 'FAST includes INTERNALDATE');
    assert.match(fast, /RFC822\.SIZE \d+/, 'FAST includes RFC822.SIZE');
    assert.doesNotMatch(fast, /ENVELOPE/, 'FAST does not include ENVELOPE');
    c.send('a4 FETCH 1 ALL\r\n');
    const all = await c.until('a4');
    assert.match(all, /INTERNALDATE "15-Jan-2025 09:30:00 \+0000"/, 'ALL includes INTERNALDATE');
    assert.match(all, /ENVELOPE \(/, 'ALL includes ENVELOPE');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('APPEND preserves a client-supplied date; COPY carries it to the target', async () => {
  const cat = new MemoryCatalog();
  cat.create('Archive');
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = new C(net.connect(server.port, '127.0.0.1'));
  try {
    c.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await c.until('a2');
    const msg = 'Subject: restored\r\n\r\nfrom an old backup\r\n';
    c.send(`a3 APPEND INBOX (\\Seen) "02-Mar-2019 14:00:00 +0000" {${Buffer.byteLength(msg)}}\r\n`);
    await delay(30);
    c.send(msg + '\r\n');
    await c.until('a3');
    c.send('a4 FETCH 1 (INTERNALDATE FLAGS)\r\n');
    const fetched = await c.until('a4');
    // The day is SP-padded to width 2 per the RFC 9051 date-day-fixed ABNF.
    assert.match(fetched, /INTERNALDATE " 2-Mar-2019 14:00:00 \+0000"/, 'the APPENDed date is preserved exactly');
    assert.match(fetched, /FLAGS \(\\Seen\)/, 'the APPENDed flag is preserved');

    c.send('a5 UID COPY 1 Archive\r\n');
    await c.until('a5');
    assert.equal(cat.get('Archive')!.messages[0]!.internalDate, Date.UTC(2019, 2, 2, 14, 0, 0), 'COPY keeps the internal date');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('APPEND without a date stamps a current, well-formed INTERNALDATE (not 1970)', async () => {
  const cat = new MemoryCatalog();
  const before = Date.now();
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = new C(net.connect(server.port, '127.0.0.1'));
  try {
    c.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await c.until('a2');
    const msg = 'Subject: no date\r\n\r\nbody\r\n';
    c.send(`a3 APPEND INBOX {${Buffer.byteLength(msg)}}\r\n`);
    await delay(30);
    c.send(msg + '\r\n');
    await c.until('a3');
    const stamped = cat.get('INBOX')!.messages[0]!.internalDate;
    assert.ok(stamped >= before && stamped <= Date.now() + 1000, 'a dateless APPEND is stamped with the current time');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
