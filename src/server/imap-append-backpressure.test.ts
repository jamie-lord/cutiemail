/**
 * APPEND in-flight budget (docs/PERFORMANCE.md). An APPEND buffers the whole declared literal in
 * the connection's receive buffer before storing it, so many connections declaring big literals and
 * uploading slowly pin memory without bound — the read-side twin of the FETCH slow-consumer OOM
 * (reproduced live: RSS grew ~23 MB per stalled APPEND on the box, tripping the kernel's TCP OOM).
 * The fix reserves each literal's DECLARED size against a server-wide budget and refuses a new APPEND
 * (transient NO) once that would exceed it; the reservation is released on completion, error, or
 * disconnect.
 *
 * This drives real connections: fill the budget with held (un-sent) APPENDs, prove the next is
 * refused, then prove a reservation is freed both by completing an upload and by disconnecting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function client(port: number): { sock: net.Socket; send: (s: string | Buffer) => void; until: (re: RegExp) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.on('data', (d) => (buf += d.toString('latin1')));
  sock.on('error', () => {});
  const until = async (re: RegExp): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const m = re.exec(buf);
      if (m !== null) {
        buf = buf.slice(m.index + m[0].length);
        return m[0];
      }
      await delay(5);
    }
    throw new Error(`timeout for ${re}: ${buf.slice(-80)}`);
  };
  return { sock, send: (s) => sock.write(typeof s === 'string' ? Buffer.from(s, 'latin1') : s), until };
}

/** A logged-in connection that has issued `APPEND INBOX {size}` and is holding at the go-ahead/NO. */
async function beginAppend(port: number, tag: string, size: number): Promise<{ c: ReturnType<typeof client>; reply: string }> {
  const c = client(port);
  await new Promise<void>((r) => c.sock.once('connect', () => r()));
  await c.until(/\* OK[^\n]*\n/);
  c.send('lg LOGIN u p\r\n');
  await c.until(/lg OK[^\n]*\n/);
  c.send(`${tag} APPEND INBOX {${size}}\r\n`);
  const reply = await c.until(/\+ |NO /); // "+ " go-ahead (reserved) or "NO " (refused)
  return { c, reply };
}

test('APPEND is refused once the in-flight budget is full, and admitted again as reservations free', async () => {
  const SIZE = 2_000_000;
  // Budget fits two 2 MB literals but not three.
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true, maxAppendInflight: 5_000_000 });
  try {
    // A and B each reserve 2 MB (4 MB) and hold at the "+ " go-ahead without sending the literal.
    const a = await beginAppend(server.port, 'a1', SIZE);
    const b = await beginAppend(server.port, 'b1', SIZE);
    assert.match(a.reply, /\+ /, 'A reserved');
    assert.match(b.reply, /\+ /, 'B reserved');

    // C would push to 6 MB > 5 MB budget → refused with a transient NO (no "+").
    const c = await beginAppend(server.port, 'c1', SIZE);
    assert.match(c.reply, /NO /, 'C is refused when the budget is full');
    c.c.sock.destroy();

    // Complete A's upload: send the 2 MB literal + CRLF. A stores it and RELEASES its 2 MB.
    a.c.send(Buffer.alloc(SIZE, 0x41));
    a.c.send('\r\n');
    await a.c.until(/a1 OK[^\n]*\n/);

    // Now only B's 2 MB is reserved, so a fresh APPEND fits again.
    const d = await beginAppend(server.port, 'd1', SIZE);
    assert.match(d.reply, /\+ /, 'a new APPEND is admitted after A completed and freed its reservation');

    // B and D hold 4 MB. E is refused. Then DISCONNECT B — its reservation must be freed on close.
    const e = await beginAppend(server.port, 'e1', SIZE);
    assert.match(e.reply, /NO /, 'E refused while B and D hold the budget');
    e.c.sock.destroy();
    b.c.sock.destroy(); // B disconnects mid-append → releases 2 MB
    await delay(60);

    const f = await beginAppend(server.port, 'f1', SIZE);
    assert.match(f.reply, /\+ /, 'a new APPEND is admitted after a holder disconnected (reservation freed on close)');

    a.c.sock.destroy();
    d.c.sock.destroy();
    f.c.sock.destroy();
  } finally {
    await server.close();
  }
});
