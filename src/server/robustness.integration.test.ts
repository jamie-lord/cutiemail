/**
 * Internet-facing robustness: the live SMTP and IMAP servers must never crash on
 * malformed or hostile input — a parser exposed to the open internet that throws
 * takes the whole process down. Each server is fed a barrage of garbage and must
 * (a) not kill the process and (b) still serve a valid command afterwards, proving
 * the connection survived. The specific inputs are ones whose ad-hoc parsing could
 * plausibly throw: missing arguments, non-numeric sequence sets, unbalanced
 * brackets, control bytes, and absurdly long tokens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Conn {
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
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (this.#acc.toString('latin1').includes(needle)) return this.#acc.toString('latin1');
      await delay(5);
    }
    throw new Error(`timed out on ${JSON.stringify(needle)} in ${JSON.stringify(this.#acc.toString('latin1'))}`);
  }
}

test('IMAP survives a barrage of malformed commands and still serves a valid one', async () => {
  const catalog = new MemoryCatalog();
  catalog.get('INBOX')!.append(Buffer.from('Subject: x\r\n\r\nb\r\n', 'latin1'));
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const c = new Conn(net.connect(server.port, '127.0.0.1'));
  try {
    await c.waitFor('* OK');
    c.send('a1 LOGIN u p\r\na2 SELECT INBOX\r\n');
    await c.waitFor('a2 OK');

    // Garbage that could trip the ad-hoc parser.
    const garbage = [
      'g1 FETCH',                              // missing args
      'g2 FETCH notanumber (FLAGS)',           // non-numeric sequence set
      'g3 UID FETCH 1:x (BODY[',               // unterminated section
      'g4 STORE 1',                            // missing operation
      'g5 FETCH 1 (BODY[HEADER.FIELDS (]))',   // unbalanced parens
      'g6 CREATE',                             // missing mailbox
      'g7 \x01\x02\x03 weird bytes',           // control characters
      'g8 FETCH ' + '9'.repeat(5000) + ' (FLAGS)', // absurd number
      'not even tagged garbage',               // no tag/command shape
    ].join('\r\n');
    c.send(garbage + '\r\n');
    // Some produce BAD/NO/OK; the point is the process is alive and the socket open.
    c.send('z1 NOOP\r\n');
    const after = await c.waitFor('z1 OK');
    assert.match(after, /z1 OK/, 'the connection survived the garbage and serves a valid command');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('an unterminated command line is bounded, not buffered without limit', async () => {
  // IMAP: stream a huge line with no CRLF; the server must cut it off, not OOM.
  const imap = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true });
  const ci = new Conn(net.connect(imap.port, '127.0.0.1'));
  try {
    await ci.waitFor('* OK');
    const chunk = 'a1 LOGIN ' + 'x'.repeat(20000);
    for (let i = 0; i < 5; i++) ci.send(chunk); // ~100 KB, no CRLF
    await ci.waitFor('BAD command line too long');
  } finally {
    ci.sock.destroy();
    await imap.close();
  }
  // SMTP: same.
  const smtp = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test' });
  const cs = new Conn(net.connect(smtp.port, '127.0.0.1'));
  try {
    await cs.waitFor('ESMTP');
    for (let i = 0; i < 5; i++) cs.send('X'.repeat(20000)); // ~100 KB, no CRLF
    await cs.waitFor('500 5.5.2 command line too long');
  } finally {
    cs.sock.destroy();
    await smtp.close();
  }
});

test('SMTP survives malformed commands and still completes a valid transaction', async () => {
  const delivered: unknown[] = [];
  const server = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test' });
  const c = new Conn(net.connect(server.port, '127.0.0.1'));
  try {
    await c.waitFor('ESMTP');
    const garbage = [
      'MAIL',                                  // no args
      'MAIL FROM:',                            // no address
      'RCPT TO:<unterminated',                 // unbalanced angle
      'MAIL FROM:<a@b> SIZE=notanumber',       // bad SIZE
      '\x00\x01\x02',                          // control bytes
      'X'.repeat(4000),                        // very long unknown command
      'DATA',                                  // DATA with no recipients
    ].join('\r\n');
    c.send(garbage + '\r\n');
    // A valid transaction after the garbage must still work.
    c.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\nSubject: ok\r\n\r\nfine\r\n.\r\n');
    await c.waitFor('message stored');
    assert.equal(delivered.length, 1, 'a valid transaction completes after the garbage');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('an idle SMTP connection is timed out (421) rather than held open forever', async () => {
  const server = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test', idleTimeoutMs: 150 });
  const c = new Conn(net.connect(server.port, '127.0.0.1'));
  try {
    await c.waitFor('ESMTP');
    // Send nothing — a slowloris. The server must close the idle connection itself.
    await c.waitFor('421');
    await delay(50);
    assert.ok(c.sock.destroyed || c.sock.readyState !== 'open', 'the idle connection was closed by the server');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('an idle IMAP connection is autologged out (* BYE) rather than held open forever', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true, autologoutMs: 150 });
  const c = new Conn(net.connect(server.port, '127.0.0.1'));
  try {
    await c.waitFor('* OK');
    // Send nothing — the autologout timer must fire and close the connection.
    await c.waitFor('* BYE');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
