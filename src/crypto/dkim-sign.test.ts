/**
 * The DKIM signing corpus (RFC 6376 §5), with negative controls. The headline case
 * is a full sign → verify ROUND-TRIP: a message signed by our signer verifies
 * through our §3.7 verifier, and a tamper breaks it. Real RSA throughout. Cites
 * compile-checked CryptoRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signMessage } from './dkim-sign.ts';
import type { SignParams } from './dkim-sign.ts';
import { parseDkimSignature } from './dkim-signature.ts';
import { verifyBodyHash } from './dkim-bodyhash.ts';
import { buildSigningInput, verifySignature } from './dkim-verify.ts';
import type { SignedField } from './dkim-verify.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const FIELDS: SignedField[] = [
  { name: 'From', value: 'alice@example.com' },
  { name: 'To', value: 'bob@example.net' },
  { name: 'Subject', value: 'round trip' },
];
const BODY = Buffer.from('This message is DKIM-signed.\r\n', 'latin1');

function paramsFor(privateKey: SignParams['privateKey']): SignParams {
  return { domain: 'example.com', selector: 'sel', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: FIELDS, body: BODY, privateKey };
}

test('R-6376-5-a: a signed message round-trips through the verifier (useUnknownAlgorithm caught)', () => {
  cites('R-6376-5-a');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = signMessage(paramsFor(privateKey));
  assert.ok(res.ok, 'signing succeeds');
  const sig = parseDkimSignature(Buffer.from(res.header, 'latin1'));
  assert.equal(sig.algorithm, 'rsa-sha256', 'the signer uses rsa-sha256');
  assert.ok(sig.valid, 'the produced tag-list is well-formed');

  // Round-trip: body hash + signature both verify.
  assert.ok(verifyBodyHash(BODY, sig).ok, 'the body hash verifies');
  const input = buildSigningInput(FIELDS, res.header, 'relaxed');
  assert.ok(verifySignature(input, sig.signature ?? '', publicKey, 'RSA-SHA256'), 'the signature verifies');

  // Tamper the body: the body hash no longer matches.
  assert.ok(!verifyBodyHash(Buffer.from('tampered\r\n', 'latin1'), sig).ok, 'a tampered body fails');

  // Negative control: a bogus algorithm tag is emitted.
  const defect = signMessage(paramsFor(privateKey), { useUnknownAlgorithm: true });
  assert.ok(defect.ok && parseDkimSignature(Buffer.from(defect.header, 'latin1')).algorithm !== 'rsa-sha256', 'useUnknownAlgorithm must be detectable');
});

test('R-6376-5-b: the signer refuses an under-1024-bit key (allowWeakKey caught)', () => {
  cites('R-6376-5-b');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  assert.ok(!signMessage(paramsFor(privateKey)).ok, 'a 512-bit key is refused');
  // Negative control: allowing the weak key signs anyway.
  assert.ok(signMessage(paramsFor(privateKey), { allowWeakKey: true }).ok, 'allowWeakKey must be detectable');
});
