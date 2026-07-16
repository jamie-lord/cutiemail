/**
 * SMTP command-sequencing and command-validity, locked into the unit suite.
 *
 * These are the RFC 5321 MUST/MUST NOT rules the conformance corpus (the
 * project's original deliverable) found the naive server violating when pointed
 * at the live daemon. The corpus proves them against an external target; this
 * pins them in `npm test` so a regression can't slip through:
 *   - §4.1.4: RCPT with no reverse-path buffer is rejected 503
 *   - §4.1.1.1: EHLO clears a pending transaction
 *   - RSET clears it too
 *   - §4.1.2: a command carrying a control octet is rejected 501, not executed
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Conn {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  send(bytes: string | Buffer): void {
    this.sock.write(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
  }
  /** Read the next reply line beginning at `from`; returns the 3-digit code. */
  async code(from: number): Promise<{ code: number; at: number }> {
    for (let i = 0; i < 400; i++) {
      const nl = this.#acc.indexOf(Buffer.from('\r\n', 'latin1'), from);
      if (nl !== -1) {
        const line = this.#acc.subarray(from, nl).toString('latin1');
        return { code: Number(line.slice(0, 3)), at: nl + 2 };
      }
      await delay(5);
    }
    throw new Error(`timed out reading a reply from offset ${from}`);
  }
  get length(): number {
    return this.#acc.length;
  }
}

async function connect(rec: SmtpReceiver): Promise<Conn> {
  const c = new Conn(net.connect(rec.port, '127.0.0.1'));
  await c.code(0); // greeting
  return c;
}

test('RCPT with no prior MAIL is rejected 503', async () => {
  const rec = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    let at = c.length;
    c.send('EHLO client\r\n');
    at = (await c.code(at)).at;
    c.send('RCPT TO:<someone@mx.example.test>\r\n');
    assert.equal((await c.code(at)).code, 503, 'RCPT before MAIL is out of order');
    c.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('EHLO clears a pending transaction, so a following RCPT is 503', async () => {
  const rec = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    let at = c.length;
    c.send('EHLO client\r\n');
    at = (await c.code(at)).at;
    c.send('MAIL FROM:<a@b.test>\r\n');
    at = (await c.code(at)).at;
    c.send('EHLO client\r\n'); // clears the transaction
    at = (await c.code(at)).at;
    c.send('RCPT TO:<c@mx.example.test>\r\n');
    assert.equal((await c.code(at)).code, 503, 'the reverse-path buffer was cleared by EHLO');
    c.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('RSET clears a pending transaction', async () => {
  const rec = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    let at = c.length;
    c.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\n');
    await c.code(at);
    at = c.length;
    c.send('RSET\r\n');
    at = (await c.code(at)).at;
    c.send('RCPT TO:<c@mx.example.test>\r\n');
    assert.equal((await c.code(at)).code, 503, 'RSET discarded the sender');
    c.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('a command carrying a control octet is rejected 501 and not executed', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    let at = c.length;
    c.send('EHLO client\r\n');
    at = (await c.code(at)).at;
    // MAIL FROM with an embedded NUL octet.
    c.send(Buffer.concat([Buffer.from('MAIL FROM:<a@b.test>\x00extra', 'latin1'), Buffer.from('\r\n', 'latin1')]));
    assert.equal((await c.code(at)).code, 501, 'control character in a command is rejected');
    c.sock.destroy();
  } finally {
    await rec.close();
  }
});

test('a normal transaction still works after the stricter rules', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    c.send('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\nSubject: ok\r\n\r\nbody\r\n.\r\n');
    // Drain to the stored reply.
    for (let i = 0; i < 400; i++) {
      if (delivered.length === 1) break;
      await delay(5);
    }
    assert.equal(delivered.length, 1, 'the happy path is unaffected');
    c.sock.destroy();
  } finally {
    await rec.close();
  }
});
