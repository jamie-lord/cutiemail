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
