/**
 * Opportunistic STARTTLS on the delivery client. Two behaviours matter: when the
 * peer advertises STARTTLS the transaction runs encrypted (Gmail drops the "not
 * encrypted" indicator, and mail-in-transit is private); when it does NOT, the
 * client falls back to plaintext rather than failing to deliver. Driven against
 * the real SmtpReceiver, which advertises STARTTLS and terminates a real TLS
 * handshake — so `overTls` on the delivered message is ground truth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from './deliver.ts';
import { SmtpReceiver } from '../server/smtp-receiver.ts';
import type { DeliveredMessage } from '../server/smtp-receiver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

test('opportunistic STARTTLS: the transaction runs over TLS when the peer advertises it', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => received.push(m), { domain: 'mx.example.test', tls: { key: TEST_KEY, cert: TEST_CERT } });
  try {
    const data = Buffer.from('Subject: encrypted\r\n\r\nsent over TLS\r\n', 'latin1');
    const result = await deliver(
      { host: '127.0.0.1', port: mx.port, tls: 'none' },
      { from: 'me@x.test', recipients: ['you@mx.example.test'], data, clientName: 'client.example.test' },
      {},
      undefined,
      { startTls: true },
    );
    assert.ok(result.ok, `delivery should succeed: ${result.failure}`);
    assert.equal(received.length, 1);
    assert.ok(received[0]!.overTls, 'the message was delivered inside the TLS session');
    assert.deepEqual(received[0]!.data, data, 'byte-exact through the encrypted channel');
  } finally {
    await mx.close();
  }
});

test('falls back to plaintext when the peer does not advertise STARTTLS', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => received.push(m), { domain: 'mx.example.test' }); // no tls -> no STARTTLS advertised
  try {
    const data = Buffer.from('Subject: plain\r\n\r\nno tls here\r\n', 'latin1');
    const result = await deliver(
      { host: '127.0.0.1', port: mx.port, tls: 'none' },
      { from: 'me@x.test', recipients: ['you@mx.example.test'], data, clientName: 'client.example.test' },
      {},
      undefined,
      { startTls: true },
    );
    assert.ok(result.ok, `delivery should still succeed over plaintext: ${result.failure}`);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.overTls, false, 'delivered in the clear when TLS was unavailable');
  } finally {
    await mx.close();
  }
});
