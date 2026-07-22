/**
 * Graceful shutdown must not close the store under a delivery handler that is still running. A
 * handler blocked mid-store (a real one waits on verifyDkim DNS, then an SQLITE write) would, if
 * close() destroyed sockets and returned immediately, resume and write to an already-closed
 * database. close() now drains in-flight handlers first. Reproduce-first: with the drain reverted
 * (close() not awaiting in-flight handlers), close() resolves while the handler is still blocked
 * and the closeResolved assertion below fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpReceiver } from './smtp-receiver.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Drive a full SMTP transaction over a raw socket up to the terminating dot, then return. */
async function sendMessage(port: number): Promise<net.Socket> {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const step = async (line: string, expect: RegExp): Promise<void> => {
    const from = acc.length;
    sock.write(Buffer.from(line, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (expect.test(acc.slice(from))) return;
      await delay(5);
    }
    throw new Error(`timed out after ${line.trim()}: ${acc.slice(from)}`);
  };
  await step('', /^220 /); // greeting
  await step('EHLO client.test\r\n', /^250 |^250-/m);
  await step('MAIL FROM:<a@example.test>\r\n', /^250 /m);
  await step('RCPT TO:<b@example.test>\r\n', /^250 /m);
  await step('DATA\r\n', /^354 /m);
  // Send the body + terminator; do NOT wait for the 250 (the handler is gated below).
  sock.write(Buffer.from('Subject: hi\r\n\r\nbody\r\n.\r\n', 'latin1'));
  return sock;
}

test('close() drains an in-flight delivery handler before resolving (no store-close under a live handler)', async () => {
  let releaseHandler = (): void => {};
  const handlerGate = new Promise<void>((r) => { releaseHandler = r; });
  let handlerStarted = false;
  let handlerFinished = false;
  let rejected = false;
  const onRejection = (): void => { rejected = true; };
  process.on('unhandledRejection', onRejection);

  const receiver = await SmtpReceiver.start(async () => {
    handlerStarted = true;
    await handlerGate; // simulate a handler blocked mid-store (verifyDkim DNS, an SQLITE write)
    handlerFinished = true;
  });

  const sock = await sendMessage(receiver.port);
  // Wait until the message has actually reached the (now-blocked) handler.
  for (let i = 0; i < 200 && !handlerStarted; i++) await delay(5);
  assert.ok(handlerStarted, 'the delivery handler was invoked');

  // Begin shutdown while the handler is still blocked.
  let closeResolved = false;
  const closing = receiver.close().then(() => { closeResolved = true; });

  await delay(60);
  assert.equal(handlerFinished, false, 'the handler is still blocked');
  assert.equal(closeResolved, false, 'close() has NOT resolved while a handler is in flight (it drains)');

  // Release the handler; close() should now drain and resolve.
  releaseHandler();
  await closing;
  assert.equal(handlerFinished, true, 'the in-flight handler ran to completion before shutdown finished');
  assert.equal(closeResolved, true, 'close() resolves once the drained handler completes');

  await delay(20);
  process.removeListener('unhandledRejection', onRejection);
  assert.equal(rejected, false, 'no unhandled rejection on shutdown');
  sock.destroy();
});
