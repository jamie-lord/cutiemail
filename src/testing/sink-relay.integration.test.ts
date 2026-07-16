/**
 * Integration: the mutant relays to a sink, so the transparency requirements
 * (dot-un-stuffing §4.5.2, local-part case preservation §2.4-d) become
 * observable and — crucially — DETECTABLE. (§2.4-d is the PRESERVE-case-on-relay
 * duty proven here; §2.4-c is the distinct treat-as-case-sensitive duty.) Each is
 * proven both ways: a clean
 * relay delivers a faithful message to the sink; a defective one corrupts it in
 * exactly the way the requirement forbids, and the corruption shows up at the
 * sink. This is the negative-control proof for the delivery-path surface that was
 * `not-testable` from the client side alone (decision 0005).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MutantServer } from './mutant-server.ts';
import type { Defects } from './mutant-server.ts';
import { SinkServer } from './sink-server.ts';
import { dotStuff } from '../wire/bytes.ts';

/** Lockstep-deliver a message (body already stuffed by the caller) to `port`. */
async function deliverTo(port: number, from: string, recipient: string, stuffedBody: Buffer): Promise<void> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  const readLine = (): Promise<void> =>
    new Promise((resolve) => {
      const onData = (): void => {
        sock.removeListener('data', onData);
        resolve();
      };
      sock.on('data', onData);
    });
  await readLine(); // greeting
  const cmd = async (line: string): Promise<void> => {
    sock.write(Buffer.from(line + '\r\n', 'latin1'));
    await readLine();
  };
  await cmd('EHLO client.test');
  await cmd(`MAIL FROM:<${from}>`);
  await cmd(`RCPT TO:<${recipient}>`);
  await cmd('DATA');
  sock.write(Buffer.concat([stuffedBody, Buffer.from('\r\n.\r\n', 'latin1')]));
  await readLine(); // 250 accepted (the mutant now relays to the sink)
  await cmd('QUIT');
  sock.destroy();
}

/** Poll the sink until it has at least one message, or time out. */
async function waitForDelivery(sink: SinkServer, timeoutMs = 3000): Promise<void> {
  const deadline = timeoutMs / 20;
  for (let i = 0; i < deadline; i++) {
    if (sink.received.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function relayThrough(defects: Defects, from: string, recipient: string, body: Buffer): Promise<SinkServer> {
  const sink = await SinkServer.start();
  const mutant = await MutantServer.start({ defects, relayTo: sink.port });
  try {
    await deliverTo(mutant.port, from, recipient, dotStuff(body));
    await waitForDelivery(sink);
  } finally {
    await mutant.close();
  }
  return sink; // caller reads sink.last then closes
}

// The clean relay prepends a Received: trace line (§4.4), so we assert on the
// un-stuffed line's PRESENCE among the delivered lines, not whole-body equality.
test('§4.5.2 dot-un-stuffing: a clean relay delivers the un-stuffed body faithfully', async () => {
  const body = Buffer.from('.leading dot line\r\nplain line', 'latin1');
  const sink = await relayThrough({}, 'sender@example.com', 'rcpt@example.com', body);
  try {
    assert.equal(sink.received.length, 1, 'the sink should have received the relayed message');
    const lines = sink.last!.data.toString('latin1').split('\r\n');
    assert.ok(lines.includes('.leading dot line'), 'the leading transport dot should be removed');
    assert.ok(!lines.includes('..leading dot line'), 'no doubled dot should survive');
  } finally {
    await sink.close();
  }
});

test('§4.5.2 dot-un-stuffing: dontUnstuffOnRelay is DETECTED as an extra leading dot at the sink', async () => {
  const body = Buffer.from('.leading dot line\r\nplain line', 'latin1');
  const sink = await relayThrough({ dontUnstuffOnRelay: true }, 'sender@example.com', 'rcpt@example.com', body);
  try {
    assert.equal(sink.received.length, 1);
    // The server never removed the transport dot, so the sink sees TWO dots.
    const lines = sink.last!.data.toString('latin1').split('\r\n');
    assert.ok(lines.includes('..leading dot line'), 'the doubled transport dot should survive a non-un-stuffing relay');
    assert.ok(!lines.includes('.leading dot line'), 'the single-dot form should NOT appear');
  } finally {
    await sink.close();
  }
});

test('§2.4-d local-part case preservation: a clean relay preserves the mixed-case recipient', async () => {
  const sink = await relayThrough({}, 'sender@example.com', 'Mixed.Case@example.com', Buffer.from('hi', 'latin1'));
  try {
    assert.deepEqual(sink.last!.recipients, ['Mixed.Case@example.com']);
  } finally {
    await sink.close();
  }
});

test('§2.4-d local-part case preservation: lowercaseLocalPartOnRelay is DETECTED at the sink', async () => {
  const sink = await relayThrough({ lowercaseLocalPartOnRelay: true }, 'sender@example.com', 'Mixed.Case@example.com', Buffer.from('hi', 'latin1'));
  try {
    // The domain is untouched; the local-part was wrongly folded.
    assert.deepEqual(sink.last!.recipients, ['mixed.case@example.com']);
  } finally {
    await sink.close();
  }
});
