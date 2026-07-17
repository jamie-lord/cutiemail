/**
 * Opportunistic STARTTLS fallback (RFC 3207): a remote MX may advertise STARTTLS and
 * then fail the TLS handshake (old/misconfigured servers do). Opportunistic means
 * "try TLS, but deliver anyway if it fails" — so the relay must fall back to plaintext
 * on the same host rather than let a broken-TLS MX bounce the message. A MX that simply
 * refuses STARTTLS (non-2yz) is already handled by continuing in plaintext.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { relayOutbound } from './outbound.ts';

/** A mock MX that advertises STARTTLS, accepts the command, then breaks the handshake. */
async function brokenTlsMx(): Promise<{ port: number; deliveredPlaintext: () => boolean; close: () => Promise<void> }> {
  let plaintext = false;
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('220 mx.test ESMTP\r\n');
    sock.on('data', (d) => {
      const line = d.toString('latin1');
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-mx.test\r\n250 STARTTLS\r\n');
      else if (line.toUpperCase().startsWith('STARTTLS')) {
        sock.write('220 go ahead\r\n');
        setTimeout(() => sock.write('not-valid-TLS-bytes-breaking-the-handshake\r\n'), 10);
      } else if (cmd === 'MAIL') sock.write('250 2.1.0 Ok\r\n');
      else if (cmd === 'RCPT') sock.write('250 2.1.5 Ok\r\n');
      else if (cmd === 'DATA') sock.write('354 go\r\n');
      else if (line.includes('\r\n.\r\n') || line.trim() === '.') {
        plaintext = true;
        sock.write('250 2.0.0 accepted\r\n');
      } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, deliveredPlaintext: () => plaintext, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('a MX that fails the STARTTLS handshake still gets the mail via a plaintext fallback', async () => {
  const mx = await brokenTlsMx();
  try {
    const results = await relayOutbound(
      { from: 'a@us.test', recipients: ['b@remote.test'], data: Buffer.from('From: a@us.test\r\nSubject: t\r\n\r\nbody\r\n', 'latin1') },
      { clientName: 'us.test', resolveHosts: async () => ['127.0.0.1'], port: mx.port },
    );
    assert.equal(results[0]!.classification, 'success', 'the message was delivered despite the TLS failure');
    assert.ok(mx.deliveredPlaintext(), 'delivery completed over the plaintext fallback connection');
  } finally {
    await mx.close();
  }
});

test('a null-MX domain (RFC 7505) bounces immediately, not after the give-up window', async () => {
  const { relayOutbound } = await import('./outbound.ts');
  // resolveMxHosts maps a null MX ("MX 0 .") to the single host ".".
  const results = await relayOutbound(
    { from: 'a@us.test', recipients: ['b@accepts-no-mail.test'], data: Buffer.from('x', 'latin1') },
    { clientName: 'us.test', resolveHosts: async () => ['.'] },
  );
  assert.equal(results[0]!.classification, 'permanent', 'a null MX is a permanent failure');
  assert.match(results[0]!.detail, /null MX/, 'the reason names the null MX');
});
