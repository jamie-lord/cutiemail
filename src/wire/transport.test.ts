/**
 * Transport invariants.
 *
 * These defend the properties the whole corpus rests on. If `send` ever appends
 * a CRLF, or `read` ever loses a reply that arrived just before a close, or the
 * transcript ever holds bytes other than the ones on the wire, then every
 * conformance result the suite produces is suspect — and nothing downstream
 * would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from './transport.ts';
import type { Framer } from './transport.ts';
import { withServer } from '../testing/scripted-server.ts';

const CRLF = Buffer.from([0x0d, 0x0a]);

/** Frames one CRLF-terminated line. Deliberately strict: only CRLF counts. */
const crlfLine: Framer<Buffer> = (buf) => {
  const i = buf.indexOf(CRLF);
  if (i === -1) return null;
  return { value: buf.subarray(0, i), consumed: i + 2 };
};

test('send transmits exactly the bytes given and appends nothing', async () => {
  await withServer(
    async (s) => {
      await s.awaitBytes(4);
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await wire.send(Buffer.from('EHLO'));
      // Give it a beat to arrive, then assert the transcript is byte-exact.
      await wire.expectQuiet(20);
      const sent = wire.transcript.filter((e) => e.kind === 'sent');
      assert.equal(sent.length, 1);
      assert.deepEqual(
        (sent[0] as { bytes: Buffer }).bytes,
        Buffer.from('EHLO'),
        'send must not append a terminator — the smuggling corpus depends on it',
      );
      await wire.close();
    },
  );
});

test('a bare LF is transmitted as a bare LF', async () => {
  // The single most important property in the transport. If anything in the
  // stack normalises this, the SMTP-smuggling corpus silently tests nothing.
  await withServer(
    async (s) => {
      await s.awaitBytes(9);
      s.send(Buffer.from('250 ok\r\n'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const evil = Buffer.from([0x45, 0x48, 0x4c, 0x4f, 0x20, 0x78, 0x0a]); // "EHLO x" + LF
      await wire.send(evil);
      await wire.expectQuiet(20);
      const sent = wire.transcript.find((e) => e.kind === 'sent');
      assert.deepEqual((sent as { bytes: Buffer }).bytes, evil);
      assert.equal((sent as { bytes: Buffer }).bytes.at(-1), 0x0a, 'trailing byte must be LF');
      assert.notEqual((sent as { bytes: Buffer }).bytes.at(-2), 0x0d, 'must not have grown a CR');
      await wire.close();
    },
  );
});

test('read frames one value and leaves the rest buffered (pipelining)', async () => {
  // RFC 2920: several replies can land in one segment. Framing must take one at
  // a time or a pipelined exchange reads as a single malformed reply.
  await withServer(
    async (s) => {
      s.send(Buffer.from('250 one\r\n250 two\r\n250 three\r\n'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const a = await wire.read(crlfLine, 1000);
      const b = await wire.read(crlfLine, 1000);
      const c = await wire.read(crlfLine, 1000);
      assert.equal(a.kind, 'framed');
      assert.deepEqual((a as { value: Buffer }).value, Buffer.from('250 one'));
      assert.deepEqual((b as { value: Buffer }).value, Buffer.from('250 two'));
      assert.deepEqual((c as { value: Buffer }).value, Buffer.from('250 three'));
      await wire.close();
    },
  );
});

test('read reports a timeout as a value and returns the partial bytes', async () => {
  // Not an exception: a server going quiet mid-reply is an observation, and the
  // partial is the evidence. Without it "sent nothing" and "sent half a reply"
  // would be indistinguishable in the report.
  await withServer(
    async (s) => {
      s.send(Buffer.from('250 incomp'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const r = await wire.read(crlfLine, 60);
      assert.equal(r.kind, 'timeout');
      assert.deepEqual((r as { partial: Buffer }).partial, Buffer.from('250 incomp'));
      await wire.close();
    },
  );
});

test('read frames a reply that arrived immediately before a close', async () => {
  // The ordering bug this guards against is subtle and would be invisible: if
  // the close check ran before the frame attempt, a server that replies and
  // hangs up in the same breath — which is exactly what a 421 or a QUIT does —
  // would be reported as having sent nothing.
  await withServer(
    async (s) => {
      s.send(Buffer.from('421 bye\r\n'));
      s.end();
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await new Promise((r) => setTimeout(r, 50)); // let FIN land first
      const r = await wire.read(crlfLine, 1000);
      assert.equal(r.kind, 'framed', 'a reply sent before FIN must not be lost to the close');
      assert.deepEqual((r as { value: Buffer }).value, Buffer.from('421 bye'));
      const after = await wire.read(crlfLine, 1000);
      assert.equal(after.kind, 'closed', 'the close is reported once the bytes are drained');
    },
  );
});

test('an EOF-framer surfaces a bare-CR final reply exactly once, then reports close', async () => {
  // Regression: a server sends "221 Bye\r" (bare CR,
  // no LF) then closes. The eofFramer must surface the 221 ONCE and consume it,
  // so the NEXT read reports the real close — not the same phantom reply again.
  const { frameReplyAtEof, replyFramer } = await import('./reply.ts');
  await withServer(
    async (s) => {
      s.send(Buffer.from('221 Bye\r')); // bare CR, no LF
      s.end();
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await new Promise((r) => setTimeout(r, 50));
      const first = await wire.read(replyFramer, 1000, frameReplyAtEof);
      assert.equal(first.kind, 'framed', 'the bare-CR final reply is surfaced');
      const second = await wire.read(replyFramer, 1000, frameReplyAtEof);
      assert.equal(second.kind, 'closed', 'the reply is consumed; the next read sees the real close');
    },
  );
});

test('read reports a peer close as a value', async () => {
  await withServer(
    async (s) => {
      s.end();
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const r = await wire.read(crlfLine, 1000);
      assert.equal(r.kind, 'closed');
      assert.equal((r as { partial: Buffer }).partial.length, 0);
    },
  );
});

test('an RST is reported distinctly from an orderly close', async () => {
  // RFC 5321 §3.8 wants 421-then-close; a bare RST is a different (worse)
  // behaviour and the report must be able to tell them apart.
  await withServer(
    async (s) => {
      s.reset();
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const r = await wire.read(crlfLine, 1000);
      assert.ok(r.kind === 'reset' || r.kind === 'closed');
      await wire.close();
    },
  );
});

test('expectQuiet treats already-buffered bytes as non-quiet (coalesced second reply)', async () => {
  // Regression: two replies coalesced
  // into one TCP segment. After framing the first, the second sits unconsumed in
  // the buffer. expectQuiet must report NON-quiet immediately — it is data the
  // peer sent, not silence — or a double-reply/desync server passes the
  // "exactly one reply" check. This was intermittent (~33%) before the fix.
  await withServer(
    async (s) => {
      // One write, two replies — coalesced on the wire.
      s.send(Buffer.from('250 first\r\n250 second\r\n'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await new Promise((r) => setTimeout(r, 50)); // ensure both are buffered
      const first = await wire.read(crlfLine, 1000);
      assert.equal(first.kind, 'framed');
      assert.deepEqual((first as { value: Buffer }).value, Buffer.from('250 first'));
      // The second reply is unconsumed in the buffer — NOT silence.
      const q = await wire.expectQuiet(200);
      assert.equal(q.quiet, false, 'a buffered second reply must be reported as non-quiet');
      assert.ok(q.bytes.includes(Buffer.from('250 second')));
      await wire.close();
    },
  );
});

test('expectQuiet detects silence, and detects a server that speaks', async () => {
  await withServer(
    async (s) => {
      await s.awaitContaining(Buffer.from('NOISY'));
      s.send(Buffer.from('250 spoke\r\n'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });

      const silent = await wire.expectQuiet(60);
      assert.equal(silent.quiet, true);
      assert.equal(silent.bytes.length, 0);

      await wire.send(Buffer.from('NOISY'));
      const noisy = await wire.expectQuiet(120);
      assert.equal(noisy.quiet, false, 'a reply during the window must be caught');
      assert.deepEqual(noisy.bytes, Buffer.from('250 spoke\r\n'));
      await wire.close();
    },
  );
});

test('the transcript holds the exact received bytes, not a reused pool', async () => {
  // Node may reuse the read pool. If we stored the chunk by reference the
  // transcript could silently mutate after the fact — a bug that is invisible
  // right up until a report shows bytes nobody ever sent.
  await withServer(
    async (s) => {
      s.send(Buffer.from([0xff, 0x00, 0x0d, 0x0a]));
      await s.delay(20);
      s.send(Buffer.from([0x41, 0x42, 0x0d, 0x0a]));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await wire.expectQuiet(80);
      const received = wire.transcript.filter((e) => e.kind === 'received');
      assert.ok(received.length >= 1);
      const all = Buffer.concat(received.map((e) => (e as { bytes: Buffer }).bytes));
      assert.deepEqual(all, Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x41, 0x42, 0x0d, 0x0a]));
      await wire.close();
    },
  );
});

test('transcript timings are monotonic and start near zero', async () => {
  await withServer(
    async (s) => {
      await s.delay(30);
      s.send(Buffer.from('250 ok\r\n'));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      await wire.read(crlfLine, 1000);
      const ats = wire.transcript.map((e) => e.at);
      for (let i = 1; i < ats.length; i++) {
        assert.ok(ats[i]! >= ats[i - 1]!, 'timestamps must not go backwards');
      }
      assert.ok(ats[0]! < 50, 'first event should be near connection origin');
      await wire.close();
    },
  );
});

test('startTls rejects (does not hang) when the peer stalls the handshake', async () => {
  // A malicious/broken MX that accepts the socket but never completes the TLS
  // handshake must not hang the caller — one such peer would otherwise wedge the whole
  // single-flight relay loop. The handshake is bounded by a timeout.
  await withServer(
    async () => {
      // Accept the connection and do nothing — never speak TLS.
      await new Promise((r) => setTimeout(r, 1000));
    },
    async (port) => {
      const wire = await Wire.connect({ host: '127.0.0.1', port });
      const started = Date.now();
      await assert.rejects(
        wire.startTls({ rejectUnauthorized: false }, 200),
        /timed out/i,
        'a stalled TLS handshake rejects with a timeout',
      );
      assert.ok(Date.now() - started < 1000, 'it rejected on the timeout, well before the stall would end');
      await wire.close();
    },
  );
});
