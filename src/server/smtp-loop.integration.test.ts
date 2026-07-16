/**
 * Mail-loop detection on the live receiver (RFC 5321 §6.3): a message that
 * arrives carrying at least the hop threshold of Received: headers is rejected
 * 554, not accepted and stored — otherwise a forwarding loop would circulate a
 * message forever. A message just under the threshold still delivers.
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
    throw new Error(`timed out on ${JSON.stringify(needle)}`);
  }
}

const messageWith = (received: number): string => {
  const hops = Array.from({ length: received }, (_, i) => `Received: from hop${i}.example by us with ESMTP; date`).join('\r\n');
  return `${hops}\r\nSubject: loop test\r\n\r\nbody\r\n.\r\n`;
};

test('a message at the hop threshold is rejected 554 as a loop', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test', maxReceivedHops: 10 });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\n');
    await r.line('354');
    r.send(messageWith(10));
    await r.line('554');
    assert.equal(delivered.length, 0, 'the looping message was not stored');
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('a message just under the threshold still delivers', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test', maxReceivedHops: 10 });
  try {
    const r = new Reader(net.connect(rec.port, '127.0.0.1'));
    await r.line('ESMTP');
    r.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\n');
    await r.line('354');
    r.send(messageWith(9));
    await r.line('message stored');
    assert.equal(delivered.length, 1);
    r.sock.destroy();
  } finally {
    await rec.close();
  }
});
