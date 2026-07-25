/**
 * `Wire` against a peer that is not merely slow but adversarial.
 *
 * Two defects, both reachable from the outbound relay — where the remote MX is chosen by whoever
 * we are sending to — and both fatal to the whole daemon rather than to one delivery, because the
 * relay loop drains the outbound queue under a single-flight guard on a single event loop:
 *
 *  1. A peer that stops reading stalls `send()` forever. Every other phase was bounded (connect,
 *     each read, the TLS handshake, close); the write was not.
 *  2. A peer that floods while no read is pending grows `#buffer` and the `#events` transcript
 *     without limit. reply.ts's MAX_REPLY_BYTES only applies inside the framer, so it lapses for
 *     the whole of `transmitData`'s write and during `expectQuiet`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Wire } from './transport.ts';

/**
 * A listener that accepts and then does exactly what the test tells it to. The peer swallows its
 * own socket errors: when the flood guard fires we destroy the connection, and the peer's next
 * write lands on a closed pipe — EPIPE there is the guard working, not a fault.
 */
async function hostile(onConn: (sock: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    onConn(sock);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

test('send() gives up on a peer that stops reading, instead of hanging the caller forever', async () => {
  // The peer completes the TCP handshake and then never reads a byte. Our send buffer fills and
  // socket.write's completion callback is never invoked.
  const held: net.Socket[] = [];
  const peer = await hostile((sock) => {
    sock.pause();
    held.push(sock);
  });
  try {
    const wire = await Wire.connect({ host: '127.0.0.1', port: peer.port, tls: 'none', writeTimeoutMs: 750 });
    // Comfortably past any socket buffer, so the write cannot complete locally.
    const body = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const started = Date.now();
    await assert.rejects(
      wire.send(body),
      /write timeout/,
      'a stalled write must reject, not hang the relay loop for every account',
    );
    assert.ok(Date.now() - started < 10_000, 'and it must reject on the deadline, not eventually');
  } finally {
    for (const s of held) s.destroy();
    await peer.close();
  }
});

test('send() still succeeds against a peer that reads normally', async () => {
  const peer = await hostile((sock) => sock.resume());
  try {
    const wire = await Wire.connect({ host: '127.0.0.1', port: peer.port, tls: 'none', writeTimeoutMs: 5_000 });
    await wire.send(Buffer.alloc(4 * 1024 * 1024, 0x41));
    await wire.close();
  } finally {
    await peer.close();
  }
});

test('a flooding peer cannot grow the buffer or the transcript without bound', async () => {
  // Flood continuously with no CRLF and no read pending on our side: the framer never runs, so
  // MAX_REPLY_BYTES cannot see this. Before the cap, both #buffer and #events grew until the
  // process died.
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  const held: net.Socket[] = [];
  const peer = await hostile((sock) => {
    held.push(sock);
    const pump = (): void => {
      if (sock.destroyed) return;
      // Keep the socket busy without spinning the loop into starvation.
      if (sock.write(chunk)) setImmediate(pump);
      else sock.once('drain', pump);
    };
    pump();
  });
  try {
    const cap = 256 * 1024;
    const wire = await Wire.connect({ host: '127.0.0.1', port: peer.port, tls: 'none', maxBufferedBytes: cap });
    // Give the peer a real opportunity to overrun the cap many times over.
    await new Promise<void>((r) => setTimeout(r, 1500));
    assert.ok(
      wire.peek().length <= cap,
      `buffered bytes must stay within the cap (saw ${wire.peek().length}, cap ${cap})`,
    );
    const transcript = wire.transcript.reduce((n, e) => n + ('bytes' in e ? e.bytes.length : 0), 0);
    assert.ok(transcript <= cap * 2, `the transcript must not grow without bound either (saw ${transcript})`);
  } finally {
    for (const s of held) s.destroy();
    await peer.close();
  }
});
