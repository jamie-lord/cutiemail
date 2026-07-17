/**
 * The SMTP SIZE limit (RFC 1870) on the live receiver. Three things: EHLO
 * advertises SIZE, a MAIL FROM whose SIZE= declaration already exceeds the limit
 * is rejected up front (552, no transmission), and — the actual point — a DATA
 * body that runs past the limit is rejected mid-stream rather than buffered into
 * memory without bound. A conforming under-limit message still delivers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Reader {
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
  async line(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      if (s.includes(needle)) return s;
      await delay(5);
    }
    throw new Error(`timed out on ${JSON.stringify(needle)}: ${JSON.stringify(this.#acc.toString('latin1'))}`);
  }
}

test('EHLO advertises SIZE and an over-limit SIZE= declaration is refused 552', async () => {
  const rec = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test', maxMessageSize: 1000 });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\n');
    assert.match(await r.line('250'), /SIZE 1000/, 'SIZE is advertised with the limit');
    r.send('MAIL FROM:<a@b.test> SIZE=5000\r\n');
    await r.line('552');
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('an oversized DATA body is rejected mid-stream, not buffered', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => { delivered.push(m); }, { domain: 'mx.example.test', maxMessageSize: 2000 });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\n');
    await r.line('354');
    // Stream well past the 2000-octet cap without a terminator.
    r.send('Subject: big\r\n\r\n' + 'x'.repeat(5000));
    await r.line('552');
    assert.equal(delivered.length, 0, 'the oversized message was not stored');
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('EHLO advertises 8BITMIME and an 8-bit body is stored byte-exact', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => { delivered.push(m); }, { domain: 'mx.example.test' });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\n');
    assert.match(await r.line('250'), /8BITMIME/, '8BITMIME is advertised');
    // A body with real 8-bit octets (UTF-8 "café" = 0xc3 0xa9), declared BODY=8BITMIME.
    // A well-formed message ends its final line with CRLF; that CRLF is the same one the
    // terminating "<CRLF>.<CRLF>" reuses (RFC 5321 §4.1.1.4), so the terminator on the
    // wire is just ".<CRLF>" and the final CRLF stays part of the stored message.
    const body = Buffer.from('Subject: 8bit\r\n\r\ncafé — naïve\r\n', 'utf8');
    r.send('MAIL FROM:<a@b.test> BODY=8BITMIME\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\n');
    await r.line('354');
    r.sock.write(Buffer.concat([body, Buffer.from('.\r\n', 'latin1')]));
    await r.line('message stored');
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0]!.data, body, 'the 8-bit content was preserved byte-exact');
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('a message within the limit still delivers', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => { delivered.push(m); }, { domain: 'mx.example.test', maxMessageSize: 100_000 });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\nMAIL FROM:<a@b.test> SIZE=50\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\nSubject: ok\r\n\r\nsmall\r\n.\r\n');
    await r.line('message stored');
    assert.equal(delivered.length, 1);
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});
