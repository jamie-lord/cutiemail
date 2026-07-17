/**
 * FETCH ENVELOPE and SEARCH over the wire: the envelope formatter and the search
 * evaluator (built and unit-tested in the bed) are now driven through the live IMAP
 * server against real SQLite storage. A client fetches a structured ENVELOPE and
 * runs header/flag searches, and the server answers from the stored messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ImapServer } from './imap-server.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Client {
  #acc = Buffer.alloc(0);
  readonly #sock: net.Socket;
  constructor(port: number) {
    this.#sock = net.connect(port, '127.0.0.1');
    this.#sock.on('data', (d) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    this.#sock.on('error', () => {});
  }
  async expect(needle: string): Promise<string> {
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(n);
      if (at !== -1) {
        const consumed = this.#acc.subarray(0, at + n.length).toString('latin1');
        this.#acc = this.#acc.subarray(at + n.length);
        return consumed;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
  send(line: string): void {
    this.#sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
  }
  end(): void {
    this.#sock.end();
  }
}

const CRLF = '\r\n';

test('FETCH ENVELOPE and SEARCH answer from stored messages over the wire', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from(`From: Alice Smith <alice@example.com>${CRLF}Subject: Quarterly report${CRLF}${CRLF}body 1${CRLF}`, 'latin1'), ['\\Seen']);
  mailbox.append(Buffer.from(`From: Bob Jones <bob@example.net>${CRLF}Subject: Lunch?${CRLF}${CRLF}body 2${CRLF}`, 'latin1'));

  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN user pass');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');

    // FETCH ENVELOPE — the structured headers.
    c.send('a3 FETCH 1 ENVELOPE');
    const env = await c.expect('a3 OK');
    assert.ok(env.includes('"Quarterly report"'), 'the subject is in the envelope');
    assert.ok(env.includes('"Alice Smith"') && env.includes('"alice"') && env.includes('"example.com"'), 'the From address structure is in the envelope');

    // SEARCH by From substring (case-insensitive).
    c.send('a4 SEARCH FROM smith');
    const s1 = await c.expect('a4 OK');
    assert.ok(/\* SEARCH 1\b/.test(s1) && !/\* SEARCH.*2/.test(s1), 'SEARCH FROM smith matches only message 1');

    // SEARCH by SUBJECT.
    c.send('a5 SEARCH SUBJECT Lunch');
    const s2 = await c.expect('a5 OK');
    assert.ok(/\* SEARCH 2\b/.test(s2), 'SEARCH SUBJECT Lunch matches message 2');

    // SEARCH by flag.
    c.send('a6 SEARCH SEEN');
    const s3 = await c.expect('a6 OK');
    assert.ok(/\* SEARCH 1\b/.test(s3), 'SEARCH SEEN matches the \\Seen message');

    c.send('a7 LOGOUT');
    c.end();
  } finally {
    await imap.close();
    db.close();
  }
});

test('FETCH BODY[HEADER.FIELDS.NOT (...)] excludes the named fields (RFC 9051 §6.4.5)', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  mailbox.append(Buffer.from('From: a@x.test\r\nSubject: hi\r\nReceived: from somewhere\r\nDate: today\r\n\r\nbody\r\n', 'latin1'));
  const imap = await ImapServer.start(mailbox);
  const c = new Client(imap.port);
  try {
    await c.expect('* OK');
    c.send('a1 LOGIN u p');
    await c.expect('a1 OK');
    c.send('a2 SELECT INBOX');
    await c.expect('a2 OK');
    // Read the literal that follows the HEADER.FIELDS.NOT response.
    c.send('a3 UID FETCH 1 (BODY.PEEK[HEADER.FIELDS.NOT (RECEIVED)])');
    const resp = await c.expect('a3 OK');
    assert.ok(resp.includes('From: a@x.test'), 'From is present (not excluded)');
    assert.ok(resp.includes('Subject: hi') && resp.includes('Date: today'), 'Subject and Date are present');
    assert.ok(!resp.includes('Received: from somewhere'), 'Received is excluded by .NOT');
    c.send('a4 LOGOUT');
    c.end();
  } finally {
    await imap.close();
    db.close();
  }
});
