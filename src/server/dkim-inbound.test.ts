/**
 * Inbound DKIM verification (RFC 6376 §6) — the receive-side mirror of the signer.
 * Round-trips a message signed by our own signer through the verifier (so the test
 * needs no live DNS: the key resolver returns the matching public key), and checks the
 * verdicts that matter: a valid signature passes, a tampered body or a wrong key fails,
 * a missing key is a permerror, and an unsigned message is "none".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signMessage } from '../crypto/dkim-sign.ts';
import { verifyDkim } from './dkim-inbound.ts';
import type { SignedField } from '../crypto/dkim-verify.ts';

function signedMessage(): { message: Buffer; publicKeyDer: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headers: SignedField[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'signed message' },
    { name: 'Date', value: 'Wed, 15 Jul 2026 09:30:00 +0000' },
  ];
  const body = Buffer.from('This is the signed body.\r\n', 'latin1');
  const signed = signMessage({ domain: 'example.com', selector: 'sel', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey });
  assert.ok(signed.ok, 'signing succeeds');
  const message = Buffer.from(
    `DKIM-Signature: ${(signed as { header: string }).header}\r\n` + headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1'),
    'latin1',
  );
  return { message, publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const keyRecord = (der: string): Buffer => Buffer.from(`v=DKIM1; k=rsa; p=${der}`, 'latin1');

test('a valid DKIM signature verifies as pass', async () => {
  const { message, publicKeyDer } = signedMessage();
  const out = await verifyDkim(message, async () => keyRecord(publicKeyDer));
  assert.equal(out.verdict, 'pass');
  assert.equal(out.domain, 'example.com');
});

test('a tampered body fails the body hash', async () => {
  const { message, publicKeyDer } = signedMessage();
  const tampered = Buffer.from(message.toString('latin1').replace('signed body', 'TAMPERED'), 'latin1');
  assert.equal((await verifyDkim(tampered, async () => keyRecord(publicKeyDer))).verdict, 'fail');
});

test('a signature verified against the wrong key fails', async () => {
  const { message } = signedMessage();
  const { publicKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrong = keyRecord(other.export({ type: 'spki', format: 'der' }).toString('base64'));
  assert.equal((await verifyDkim(message, async () => wrong)).verdict, 'fail');
});

test('a missing key record is a permerror; a DNS error is a temperror', async () => {
  const { message } = signedMessage();
  assert.equal((await verifyDkim(message, async () => null)).verdict, 'permerror');
  assert.equal(
    (
      await verifyDkim(message, async () => {
        throw new Error('SERVFAIL');
      })
    ).verdict,
    'temperror',
  );
});

test('an unsigned message is "none"', async () => {
  const out = await verifyDkim(Buffer.from('Subject: hi\r\n\r\nno signature\r\n', 'latin1'), async () => null);
  assert.equal(out.verdict, 'none');
});

test('an Ed25519 (RFC 8463) signature verifies too', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { signEd25519, rawPublicKey } = await import('../crypto/dkim-ed25519.ts');
  const { computeBodyHash } = await import('../crypto/dkim-bodyhash.ts');
  const { buildSigningInput } = await import('../crypto/dkim-verify.ts');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signedHeaders = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'ed25519' },
  ];
  const body = Buffer.from('ed body\r\n', 'latin1');
  const bh = computeBodyHash(body, 'relaxed', 'sha256');
  const h = signedHeaders.map((f) => f.name.toLowerCase()).join(':');
  const sigValue = `v=1; a=ed25519-sha256; c=relaxed/relaxed; d=example.com; s=ed; h=${h}; bh=${bh}; b=`;
  const b = signEd25519(buildSigningInput(signedHeaders, sigValue, 'relaxed'), privateKey);
  const message = Buffer.from(
    `DKIM-Signature: ${sigValue}${b}\r\n` + signedHeaders.map((f) => `${f.name}: ${f.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1'),
    'latin1',
  );
  const resolve = async (): Promise<Buffer> => Buffer.from(`v=DKIM1; k=ed25519; p=${rawPublicKey(publicKey)}`, 'latin1');
  assert.equal((await verifyDkim(message, resolve)).verdict, 'pass');
  const tampered = Buffer.from(message.toString('latin1').replace('ed body', 'TAMPERED'), 'latin1');
  assert.equal((await verifyDkim(tampered, resolve)).verdict, 'fail');
});
