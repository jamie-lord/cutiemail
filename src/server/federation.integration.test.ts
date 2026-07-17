/**
 * Federation: two full daemons exchange a message. This is the capstone — it
 * drives the ENTIRE assembled system with no external dependency, proving the
 * pieces built separately compose into a working mail exchange:
 *
 *   server A: authenticated submission → §6409 fix-up → Received stamp → DKIM
 *             sign → persistent queue → relay over opportunistic STARTTLS
 *   the wire: A connects to B's inbound port (injected MX resolution)
 *   server B: inbound receive over TLS → Received stamp → loop/size checks →
 *             store → read back over IMAP
 *
 * If a message submitted to A arrives in B's mailbox carrying A's DKIM signature
 * and both servers' Received hops, the whole thing works together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync } from 'node:crypto';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Reader {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  async line(needle: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(Buffer.from(needle, 'latin1'));
      if (at !== -1) {
        this.#acc = this.#acc.subarray(at + needle.length);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out on ${JSON.stringify(needle)}`);
  }
}

const plainToken = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

test('two daemons: a submission to A is DKIM-signed, relayed, and lands in B, traced by both', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aPublicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // Server B (the recipient side) — start it first so we know its inbound port.
  const configB: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'b.example.test',
    accounts: [{ user: 'bob', pass: 'bobpass' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // Inject A's public key so B verifies A's DKIM signature without live DNS.
    dkimKeyResolver: async () => Buffer.from(`v=DKIM1; k=rsa; p=${aPublicKeyDer}`, 'latin1'),
  };
  const B = await startServer(configB);

  // Server A (the sender side) — its outbound resolves every domain to B's inbound.
  const configA: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'a.example.test',
    accounts: [{ user: 'alice', pass: 'alicepass' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    dkim: { selector: 'a1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: B.inbound.port },
  };
  const A = await startServer(configA);

  try {
    // Submit a message to A over STARTTLS + AUTH, addressed to bob at B.
    const raw = net.connect(A.submission.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.line('ESMTP\r\n');
    raw.write('EHLO alice-client\r\n');
    await rr.line('250 STARTTLS\r\n');
    raw.write('STARTTLS\r\n');
    await rr.line('Ready to start TLS\r\n');
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));
    const sr = new Reader(secure);
    secure.write('EHLO alice-client\r\n');
    await sr.line('250 AUTH PLAIN\r\n');
    secure.write('AUTH PLAIN ' + plainToken('alice', 'alicepass') + '\r\n');
    await sr.line('235');
    secure.write('MAIL FROM:<alice@a.example.test>\r\n');
    await sr.line('2.1.0 Ok\r\n');
    secure.write('RCPT TO:<bob@b.example.test>\r\n');
    await sr.line('2.1.5 Ok\r\n');
    secure.write('DATA\r\n');
    await sr.line('354');
    secure.write('Subject: hello across servers\r\n\r\nfrom A to B\r\n.\r\n');
    await sr.line('message stored\r\n');
    secure.end();

    // Wait for B to receive the relayed message. Generous budget: the relay does
    // RSA signing + a TLS handshake, and the whole suite runs test files in
    // parallel, so a tight window flakes under load.
    for (let i = 0; i < 1500 && B.mailbox.messages.length === 0; i++) await delay(10);
    assert.equal(B.mailbox.messages.length, 1, 'B received the message A relayed');

    const arrived = B.mailbox.messages[0]!.raw.toString('latin1');
    assert.match(arrived, /^DKIM-Signature: v=1;.*d=a\.example\.test/ms, "A's DKIM signature is present");
    // B verified A's signature end-to-end (A signed, B checked against A's key).
    assert.match(arrived, /^Authentication-Results: b\.example\.test; dkim=pass header\.d=a\.example\.test/m, 'B verified the DKIM signature as pass');
    assert.match(arrived, /^Received: from .* by b\.example\.test with ESMTPS/m, "B stamped its own Received hop (over TLS)");
    assert.match(arrived, /^Message-ID: </m, "A's §6409 fix-up added a Message-ID");
    assert.ok(arrived.includes('from A to B'), 'the body survived the whole path');
    // Two hops total: A (submission) and B (inbound).
    const receivedCount = (arrived.match(/^Received:/gm) ?? []).length;
    assert.equal(receivedCount, 2, 'exactly two Received hops — one per server');

    // A's queue drained (delivery succeeded, nothing left).
    assert.equal(A.queue.size, 0, "A's outbound queue is empty after delivery");
  } finally {
    await A.close();
    await B.close();
  }
});
