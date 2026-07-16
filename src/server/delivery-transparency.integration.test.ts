/**
 * Delivery transparency (RFC 5321): a server must deliver exactly what it
 * received, not a corrupted copy. These MUSTs are invisible on the SMTP
 * connection — they only show in the stored message — and the conformance corpus
 * probes them via a downstream sink, which our store-only inbound can't provide.
 * So they're verified here directly against the daemon:
 *   - §4.5.2  dot-un-stuffing: a body line the client doubled (..x) is stored .x
 *   - §4.5.2-e control octets in the body (HT, VT) reach the mailbox intact
 *   - §2.4-d  the recipient local-part case is preserved (Foo != foo)
 *   - §4.4    a Received trace line is prepended
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONFIG: MailServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  smtpPort: 0,
  submissionPort: 0,
  imapPort: 0,
  domain: 'mail.example.test',
  accounts: [{ user: 'you', pass: 'pw' }],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

/** Deliver raw DATA bytes to the inbound port; resolve when stored. */
async function deliverRaw(port: number, rcpt: string, dataBytes: Buffer): Promise<void> {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {});
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
  const until = async (needle: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (acc.includes(Buffer.from(needle, 'latin1'))) {
        acc = Buffer.alloc(0);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out on ${needle}`);
  };
  await until('ESMTP');
  sock.write(Buffer.from('EHLO probe.example\r\n', 'latin1'));
  await until('250 ');
  sock.write(Buffer.from(`MAIL FROM:<sender@probe.example>\r\n`, 'latin1'));
  await until('250 ');
  sock.write(Buffer.from(`RCPT TO:<${rcpt}>\r\n`, 'latin1'));
  await until('250 ');
  sock.write(Buffer.from('DATA\r\n', 'latin1'));
  await until('354');
  sock.write(dataBytes);
  await until('message stored');
  sock.end();
}

test('delivery transparency: dot-un-stuffing, control octets, and local-part case', async () => {
  const server = await startServer(CONFIG);
  try {
    // Body with: a dot-stuffed line (client doubled the leading dot), a tab and a
    // vertical-tab control octet, and a plain line. Terminated by <CRLF>.<CRLF>.
    const data = Buffer.from(
      'Subject: transparency\r\n\r\n' +
        '..secret leading dot\r\n' + // dot-stuffed by the client -> must store single dot
        'tab\there\tvtab\x0bhere\r\n' + // HT and VT must survive
        'plain line\r\n' +
        '.\r\n',
      'latin1',
    );
    await deliverRaw(server.inbound.port, 'MixedCase@mail.example.test', data);

    assert.equal(server.mailbox.messages.length, 1);
    const stored = server.mailbox.messages[0]!.raw.toString('latin1');

    // §4.4: a Received line was prepended, and it preserves the recipient case (§2.4-d).
    assert.match(stored, /^Received: from probe\.example .*for <MixedCase@mail\.example\.test>;/m, 'Received prepended, recipient case preserved');

    // §4.5.2: the doubled dot was un-stuffed to a single dot.
    assert.ok(stored.includes('\r\n.secret leading dot\r\n'), 'the transport dot was removed (..secret -> .secret)');
    assert.ok(!stored.includes('..secret'), 'no doubled dot survives in the stored message');

    // §4.5.2-e: control octets in the body reached the mailbox intact.
    assert.ok(stored.includes('tab\there\tvtab\x0bhere'), 'HT and VT control octets are preserved');
  } finally {
    await server.close();
  }
});
