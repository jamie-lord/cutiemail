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
  /**
   * Read one full reply beginning at `from` — consuming any `NNN-` continuation
   * lines (a multiline EHLO) and returning the FINAL line's code and the offset
   * after it.
   */
  async code(from: number): Promise<{ code: number; at: number }> {
    for (let i = 0; i < 400; i++) {
      let off = from;
      let done = false;
      let result = { code: 0, at: from };
      for (;;) {
        const nl = this.#acc.indexOf(Buffer.from('\r\n', 'latin1'), off);
        if (nl === -1) break; // need more bytes
        const line = this.#acc.subarray(off, nl).toString('latin1');
        off = nl + 2;
        if (line.length < 4 || line[3] === ' ') {
          result = { code: Number(line.slice(0, 3)), at: off };
          done = true;
          break;
        }
        // else `NNN-` continuation — keep reading
      }
      if (done) return result;
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

test('VRFY/EXPN/HELP are recognised (not 500) and do not disturb the transaction', async () => {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test' });
  try {
    const c = await connect(rec);
    let at = c.length;
    c.send('EHLO client\r\n');
    at = (await c.code(at)).at;
    // Start a transaction, then issue VRFY/EXPN/HELP — none may reset it (§4.1.1.6-8).
    c.send('MAIL FROM:<a@b.test>\r\n');
    at = (await c.code(at)).at;
    c.send('VRFY someone\r\n');
    assert.equal((await c.code(at)).code, 252, 'VRFY is recognised (252, never 500)');
    at = c.length;
    c.send('EXPN list\r\n');
    assert.equal((await c.code(at)).code, 502, 'EXPN answered 502, not 500');
    at = c.length;
    c.send('HELP\r\n');
    assert.equal((await c.code(at)).code, 214, 'HELP answered 214');
    at = c.length;
    // The transaction survived: RCPT still works (buffers were not disturbed).
    c.send('RCPT TO:<c@mx.example.test>\r\n');
    assert.equal((await c.code(at)).code, 250, 'the reverse-path buffer survived VRFY/EXPN/HELP');
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
