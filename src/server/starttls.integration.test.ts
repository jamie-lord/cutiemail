/**
 * STARTTLS on the live SMTP receiver (RFC 3207): the upgrade works and delivers over
 * TLS, and — the security-critical part — plaintext injected before the handshake is
 * DISCARDED at the upgrade (the STARTTLS command-injection defence, R-3207-4.2-a).
 * The retainBufferAcrossStarttls defect is the negative control: with it, the
 * injected transaction is executed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const TLS_OPTS = { key: TEST_KEY, cert: TEST_CERT };
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reads a socket, consuming up to and including each awaited needle. */
class Reader {
  #acc = Buffer.alloc(0);
  constructor(sock: NodeJS.ReadableStream) {
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
  }
  async until(needle: string): Promise<void> {
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(n);
      if (at !== -1) {
        this.#acc = this.#acc.subarray(at + n.length);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

test('STARTTLS: the connection upgrades and delivers over TLS', async () => {
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); }, { tls: TLS_OPTS });
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.until('ESMTP\r\n');
    raw.write('EHLO client\r\n');
    await rr.until('250 STARTTLS\r\n');
    raw.write('STARTTLS\r\n');
    await rr.until('Ready to start TLS\r\n');

    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));
    const sr = new Reader(secure);
    secure.write('EHLO client\r\n');
    await sr.until('250 8BITMIME\r\n'); // post-TLS EHLO: STARTTLS gone, 8BITMIME is the final line
    secure.write('MAIL FROM:<a@example.com>\r\n');
    await sr.until('2.1.0 Ok\r\n');
    secure.write('RCPT TO:<b@example.net>\r\n');
    await sr.until('2.1.5 Ok\r\n');
    secure.write('DATA\r\n');
    await sr.until('354');
    secure.write('Subject: over tls\r\n\r\nsecret body\r\n.\r\n');
    await sr.until('message stored\r\n');
    secure.end();

    assert.equal(delivered.length, 1, 'one message delivered');
    assert.ok(delivered[0]!.overTls, 'it was delivered over TLS');
    assert.ok(delivered[0]!.data.includes(Buffer.from('secret body')), 'the body arrived');
  } finally {
    await receiver.close();
  }
});

/** Send STARTTLS immediately followed by a full plaintext transaction (the injection). */
async function attemptInjection(retain: boolean): Promise<DeliveredMessage[]> {
  const delivered: DeliveredMessage[] = [];
  const receiver = await SmtpReceiver.start((m) => { delivered.push(m); }, { tls: TLS_OPTS, retainBufferAcrossStarttls: retain });
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.until('ESMTP\r\n');
    raw.write('EHLO evil\r\n');
    await rr.until('250 STARTTLS\r\n');
    // STARTTLS then a whole injected transaction, in one plaintext write.
    raw.write('STARTTLS\r\nMAIL FROM:<evil@attacker.example>\r\nRCPT TO:<victim@example.com>\r\nDATA\r\ninjected body\r\n.\r\n');
    await delay(120);
    raw.destroy();
  } finally {
    await receiver.close();
  }
  return delivered;
}

test('STARTTLS: a stalled TLS handshake is dropped within the handshake deadline (slowloris)', async () => {
  // Reproduce-first: without a handshake deadline the manually-constructed TLSSocket
  // waits forever for handshake bytes, and the socket idle timer resets on each
  // dribbled byte, so the connection wedges open. With the deadline the server drops it.
  const receiver = await SmtpReceiver.start(() => {}, { tls: TLS_OPTS, tlsHandshakeTimeoutMs: 200 });
  try {
    const raw = net.connect(receiver.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.until('ESMTP\r\n');
    raw.write('EHLO client\r\n');
    await rr.until('250 STARTTLS\r\n');
    raw.write('STARTTLS\r\n');
    await rr.until('Ready to start TLS\r\n');
    // Never actually negotiate TLS: dribble the first couple of bytes of a TLS record
    // and then stall. The handshake never completes; the deadline must drop the socket.
    raw.write(Buffer.from([0x16, 0x03]));
    const dropped = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
      raw.once('close', () => finish(true));
      raw.once('end', () => finish(true));
      setTimeout(() => finish(false), 2000); // generous ceiling; the deadline is 200ms
    });
    assert.ok(dropped, 'the server dropped the stalled STARTTLS handshake within the deadline');
  } finally {
    await receiver.close();
  }
});

test('STARTTLS: plaintext injected before the handshake is discarded (retainBufferAcrossStarttls caught)', async () => {
  // Conformant: the injected transaction is discarded — nothing is delivered.
  const conformant = await attemptInjection(false);
  assert.equal(conformant.length, 0, 'the injected plaintext transaction is NOT executed');

  // Negative control: retaining the buffer executes the injection.
  const defect = await attemptInjection(true);
  assert.ok(defect.some((m) => m.data.includes(Buffer.from('injected body'))), 'retainBufferAcrossStarttls must be detectable');
});
