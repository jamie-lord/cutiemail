/**
 * Inbound DKIM verification through the daemon: a DKIM-signed message delivered to the
 * receive path is verified and the result recorded in an Authentication-Results header
 * (RFC 8601). Uses an injected key resolver so no live DNS is needed. Verification is
 * informational — the message is stored either way (leniency preserved).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { signMessage } from '../crypto/dkim-sign.ts';
import type { SignedField } from '../crypto/dkim-verify.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function deliverInbound(port: number, message: Buffer): Promise<void> {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {});
  await new Promise<void>((r) => s.once('connect', () => r()));
  const step = (str: string | Buffer): Promise<void> =>
    new Promise((r) => {
      s.write(typeof str === 'string' ? Buffer.from(str, 'latin1') : str);
      setTimeout(r, 40);
    });
  await delay(40);
  await step('EHLO sender.test\r\n');
  await step('MAIL FROM:<alice@example.com>\r\n');
  await step('RCPT TO:<test@mail.example.test>\r\n');
  await step('DATA\r\n');
  await step(Buffer.concat([message, Buffer.from('.\r\n', 'latin1')]));
  await step('QUIT\r\n');
  s.destroy();
}

test('a DKIM-signed inbound message is verified and stamped Authentication-Results: dkim=pass', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  const headers: SignedField[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'signed inbound' },
    { name: 'Date', value: 'Wed, 15 Jul 2026 09:30:00 +0000' },
  ];
  const body = Buffer.from('inbound signed body\r\n', 'latin1');
  const signed = signMessage({ domain: 'example.com', selector: 'sel', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey });
  assert.ok(signed.ok);
  const message = Buffer.from(
    `DKIM-Signature: ${(signed as { header: string }).header}\r\n` + headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1'),
    'latin1',
  );

  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'test', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // Inject the signer's key so the verifier needs no live DNS.
    dkimKeyResolver: async () => Buffer.from(`v=DKIM1; k=rsa; p=${pubDer}`, 'latin1'),
  };
  const server = await startServer(config);
  try {
    await deliverInbound(server.inbound.port, message);
    for (let i = 0; i < 200 && server.mailbox.messages.length === 0; i++) await delay(20);
    assert.equal(server.mailbox.messages.length, 1, 'the message was stored');
    const stored = server.mailbox.messages[0]!.raw.toString('latin1');
    assert.match(stored, /^Authentication-Results: mail\.example\.test; dkim=pass header\.d=example\.com/m, 'the verified result is stamped');
    assert.match(stored, /inbound signed body/, 'the original message is intact below the trace headers');
  } finally {
    await server.close();
  }
});
