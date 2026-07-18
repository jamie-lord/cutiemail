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
import { withPeer } from '../testing/client-peer.ts';

test('opportunistic STARTTLS: the transaction runs over TLS when the peer advertises it', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); }, { domain: 'mx.example.test', tls: { key: TEST_KEY, cert: TEST_CERT } });
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

test('MTA-STS enforce: an EHLO refusal must NOT downgrade to a cleartext HELO transaction', async () => {
  // Active-attacker downgrade (audit run-3, HIGH): a MITM refuses the EHLO verb so the
  // STARTTLS-offer branch is never reached; the client used to fall back to HELO and send the
  // whole message in the clear even under requireValidCert. Under enforce that MUST be terminal.
  await withPeer({ ehloStatus: 500 }, async (peer) => {
    const r = await deliver(
      { host: '127.0.0.1', port: peer.port, tls: 'none' },
      { from: 'me@x.test', recipients: ['you@mx.example.test'], data: Buffer.from('Subject: s\r\n\r\nsecret\r\n', 'latin1'), clientName: 'client.example.test' },
      {},
      undefined,
      { startTls: true, requireValidCert: true },
    );
    assert.equal(r.ok, false, 'enforce must refuse, not send in cleartext');
    assert.match(r.failure ?? '', /encrypt|STARTTLS|TLS/i);
    assert.equal(peer.deliveries.length, 0, 'nothing was delivered in the clear');
  });
  // Negative control: WITHOUT enforce the same EHLO refusal still delivers opportunistically
  // (the HELO fallback is legitimate when TLS is not required) — the fix must not break that.
  await withPeer({ ehloStatus: 500 }, async (peer) => {
    const r = await deliver(
      { host: '127.0.0.1', port: peer.port, tls: 'none' },
      { from: 'me@x.test', recipients: ['you@mx.example.test'], data: Buffer.from('Subject: s\r\n\r\nhi\r\n', 'latin1'), clientName: 'client.example.test' },
      {},
      undefined,
      { startTls: true },
    );
    assert.ok(r.ok, `opportunistic delivery should still complete via HELO: ${r.failure}`);
    assert.ok(r.heloFellBack, 'the HELO fallback still fires without enforce');
    assert.equal(peer.deliveries.length, 1);
  });
});

test('falls back to plaintext when the peer does not advertise STARTTLS', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); }, { domain: 'mx.example.test' }); // no tls -> no STARTTLS advertised
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
