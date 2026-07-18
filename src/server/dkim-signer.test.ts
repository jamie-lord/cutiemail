/**
 * The outbound DKIM signer must produce a signature a real verifier accepts —
 * this is the difference between Gmail's inbox and its spam folder. The test
 * signs a message the way the relay will (arbitrary submitted bytes), then
 * verifies it through the SAME independent verify path the receiver suite trusts:
 * parse the DKIM-Signature, re-derive the signing input, check the body hash and
 * the RSA signature against the key published in the DNS record. A folded header
 * and the fix-up-added Date/Message-ID are included, because that's what real
 * submitted mail looks like.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { dkimSign, makeSigner, publicKeyRecord } from './dkim-signer.ts';
import { parseDkimSignature } from '../crypto/dkim-signature.ts';
import { buildSigningInput, verifySignature } from '../crypto/dkim-verify.ts';
import { verifyBodyHash } from '../crypto/dkim-bodyhash.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { parseMessage } from '../message/parse.ts';
import { ensureSubmissionHeaders } from './submission-fixup.ts';

/**
 * Verify a dkim-signed message the way a receiver does — body hash, then the RSA
 * signature over the reconstructed header input, using the key reconstructed from
 * the DNS TXT record's p= tag (the full published-key path, not a shortcut).
 */
function verifySigned(signed: Buffer, txtRecord: string): boolean {
  const parsed = parseMessage(signed);
  const hv = (name: string): string =>
    parsed.headers.find((h) => h.name.toString('latin1').trim().toLowerCase() === name.toLowerCase())?.value.toString('latin1').trim() ?? '';

  const sig = parseDkimSignature(Buffer.from(hv('DKIM-Signature'), 'latin1'));
  if (!sig.valid) return false;
  if (!verifyBodyHash(parsed.body, sig).ok) return false;

  const fields = sig.signedHeaders.map((n) => ({ name: n, value: hv(n) }));
  const input = buildSigningInput(fields, hv('DKIM-Signature'), 'relaxed');

  const rec = parseDkimKeyRecord(Buffer.from(txtRecord, 'latin1'));
  if (!rec.valid || rec.publicKey === null) return false;
  const pub = createPublicKey({ key: Buffer.from(rec.publicKey, 'base64'), format: 'der', type: 'spki' });
  return verifySignature(input, sig.signature ?? '', pub, 'RSA-SHA256');
}

test('a signed message verifies against its published key record (round trip)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = makeSigner('mailtest.example', 'test2026', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);

  const raw = ensureSubmissionHeaders(
    Buffer.from(
      'From: Test <test@mailtest.example>\r\n' +
        'To: someone@example.net\r\n' +
        'Subject: a fairly long subject line that the client may fold across two physical lines here\r\n' +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset="UTF-8"\r\n\r\n' +
        'Body that gets DKIM signed on the way out.\r\n',
      'latin1',
    ),
    'mailtest.example',
    'test@mailtest.example',
  );

  const signed = dkimSign(raw, signer);
  assert.ok(signed.length > raw.length, 'a DKIM-Signature was prepended');
  assert.ok(signed.toString('latin1').startsWith('DKIM-Signature: v=1;'));

  const txt = publicKeyRecord(publicKey.export({ type: 'spki', format: 'pem' }) as string);
  assert.ok(verifySigned(signed, txt), 'the signature verifies against the DNS-published key');
});

test('tampering with the signed body breaks verification', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = makeSigner('mailtest.example', 'test2026', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const raw = Buffer.from('From: a@mailtest.example\r\nSubject: x\r\nDate: Thu, 16 Jul 2026 00:00:00 +0000\r\nMessage-ID: <1@mailtest.example>\r\n\r\noriginal body\r\n', 'latin1');

  const signed = dkimSign(raw, signer);
  const txt = publicKeyRecord(publicKey.export({ type: 'spki', format: 'pem' }) as string);
  assert.ok(verifySigned(signed, txt), 'clean message verifies');

  const tampered = Buffer.from(signed.toString('latin1').replace('original body', 'tampered body!'), 'latin1');
  assert.equal(verifySigned(tampered, txt), false, 'a modified body must fail the body hash');
});

test('a From-less message is NOT signed (never lend d= authority to an unsigned From — run-6)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = makeSigner('mailtest.example', 'sel', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  // A submission with MAIL FROM:<> and no From header (fixup adds Date/Message-ID but no From).
  // Signing it would emit h= without From, so a downstream could append any From under our key.
  const noFrom = Buffer.from('To: someone@example.net\r\nSubject: x\r\nDate: Thu, 16 Jul 2026 00:00:00 +0000\r\nMessage-ID: <1@mailtest.example>\r\n\r\nbody\r\n', 'latin1');
  assert.equal(dkimSign(noFrom, signer), noFrom, 'a From-less message is returned unsigned (fail-open)');
  // Control: the same message WITH a From is signed.
  const withFrom = Buffer.from('From: a@mailtest.example\r\n' + noFrom.toString('latin1'), 'latin1');
  assert.ok(dkimSign(withFrom, signer).toString('latin1').startsWith('DKIM-Signature:'), 'a message with From is still signed');
});

test('a message with no header/body boundary is returned unchanged (fail-open)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = makeSigner('mailtest.example', 'sel', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const noBoundary = Buffer.from('From: a@b\r\nSubject: no body', 'latin1');
  assert.equal(dkimSign(noBoundary, signer), noBoundary);
});
