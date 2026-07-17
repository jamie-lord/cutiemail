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

test('the daemon evaluates inbound SPF and records it in Authentication-Results', async () => {
  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'test', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // The sender domain's SPF authorises the loopback address the test connects from.
    spfResolvers: {
      txt: async (n) => (n === 'sender.test' ? ['v=spf1 ip4:127.0.0.1/32 -all'] : []),
      a: async () => [],
      mx: async () => [],
    },
  };
  const server = await startServer(config);
  try {
    // A plain (unsigned) message from a MAIL FROM at sender.test.
    const s = net.connect(server.inbound.port, '127.0.0.1');
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    const step = (str: string): Promise<void> =>
      new Promise((r) => {
        s.write(Buffer.from(str, 'latin1'));
        setTimeout(r, 40);
      });
    await delay(40);
    await step('EHLO sender.test\r\n');
    await step('MAIL FROM:<bob@sender.test>\r\n');
    await step('RCPT TO:<test@mail.example.test>\r\n');
    await step('DATA\r\n');
    await step('Subject: spf check\r\n\r\nhello\r\n.\r\n');
    await step('QUIT\r\n');
    s.destroy();

    for (let i = 0; i < 200 && server.mailbox.messages.length === 0; i++) await delay(20);
    assert.equal(server.mailbox.messages.length, 1);
    const stored = server.mailbox.messages[0]!.raw.toString('latin1');
    assert.match(stored, /Authentication-Results:.*spf=pass smtp\.mailfrom=sender\.test/, 'SPF pass is recorded for the authorised loopback sender');
    assert.match(stored, /dkim=none/, 'an unsigned message is dkim=none');
  } finally {
    await server.close();
  }
});

test('the daemon evaluates DMARC (aligned SPF pass) and stamps dmarc=pass', async () => {
  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'test', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // sender.test authorises the loopback IP AND publishes a DMARC policy.
    spfResolvers: {
      txt: async (n) => {
        if (n === 'sender.test') return ['v=spf1 ip4:127.0.0.1/32 -all'];
        if (n === '_dmarc.sender.test') return ['v=DMARC1; p=reject'];
        return [];
      },
      a: async () => [],
      mx: async () => [],
    },
  };
  const server = await startServer(config);
  try {
    const s = net.connect(server.inbound.port, '127.0.0.1');
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    const step = (str: string): Promise<void> =>
      new Promise((r) => {
        s.write(Buffer.from(str, 'latin1'));
        setTimeout(r, 40);
      });
    await delay(40);
    await step('EHLO sender.test\r\n');
    await step('MAIL FROM:<bob@sender.test>\r\n');
    await step('RCPT TO:<test@mail.example.test>\r\n');
    await step('DATA\r\n');
    // The From header domain aligns with the SPF (MAIL FROM) domain.
    await step('From: Bob <bob@sender.test>\r\nSubject: dmarc check\r\n\r\nhello\r\n.\r\n');
    await step('QUIT\r\n');
    s.destroy();

    for (let i = 0; i < 200 && server.mailbox.messages.length === 0; i++) await delay(20);
    assert.equal(server.mailbox.messages.length, 1);
    const stored = server.mailbox.messages[0]!.raw.toString('latin1');
    assert.match(stored, /spf=pass smtp\.mailfrom=sender\.test/, 'SPF passes for the authorised sender');
    assert.match(stored, /dmarc=pass \(p=reject\)/, 'DMARC passes (aligned SPF) and reports the policy');
  } finally {
    await server.close();
  }
});

test('a forged Authentication-Results with our authserv-id is stripped (RFC 8601 §5)', async () => {
  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'test', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
  };
  const server = await startServer(config);
  try {
    const s = net.connect(server.inbound.port, '127.0.0.1');
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    const step = (str: string): Promise<void> =>
      new Promise((r) => {
        s.write(Buffer.from(str, 'latin1'));
        setTimeout(r, 40);
      });
    await delay(40);
    await step('EHLO evil\r\n');
    await step('MAIL FROM:<attacker@evil.test>\r\n');
    await step('RCPT TO:<test@mail.example.test>\r\n');
    await step('DATA\r\n');
    // A forged AR claiming OUR id, plus a legitimate upstream AR (different id).
    await step(
      'Authentication-Results: mail.example.test; dkim=pass header.d=trusted-bank.test\r\n' +
        'Authentication-Results: upstream.relay.test; spf=pass\r\n' +
        'From: attacker@evil.test\r\nSubject: forged\r\n\r\nphishing\r\n.\r\n',
    );
    await step('QUIT\r\n');
    s.destroy();
    for (let i = 0; i < 200 && server.mailbox.messages.length === 0; i++) await delay(20);
    const stored = server.mailbox.messages[0]!.raw.toString('latin1');
    assert.doesNotMatch(stored, /dkim=pass header\.d=trusted-bank\.test/, 'the forged our-id result is removed');
    assert.match(stored, /Authentication-Results: upstream\.relay\.test; spf=pass/, 'a different authserv-id is left intact');
    assert.match(stored, /Authentication-Results: mail\.example\.test; dkim=none/, 'our own verified result is stamped');
  } finally {
    await server.close();
  }
});
