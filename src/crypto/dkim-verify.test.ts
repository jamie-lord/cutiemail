/**
 * The DKIM signature-verification corpus (RFC 6376 §3.7 step 2), with a negative
 * control. Real crypto end-to-end: an RSA keypair is generated in-test, a message
 * is signed exactly as a signer would, and the case proves an intact message
 * verifies while a tampered signed header fails — and that skipping the check is
 * detectable. Cites a compile-checked CryptoRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { buildSigningInput, verifySignature } from './dkim-verify.ts';
import type { SignedField } from './dkim-verify.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const FIELDS: SignedField[] = [
  { name: 'From', value: 'alice@example.com' },
  { name: 'To', value: 'bob@example.net' },
  { name: 'Subject', value: 'hello dkim' },
];
// The DKIM-Signature value (b= empty at signing time), h= naming the signed fields.
const SIG_VALUE = 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=sel; h=from:to:subject; bh=irrelevant=; b=';

/** Sign the header-hash input with the private key, returning the base64 b= value. */
function sign(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const input = buildSigningInput(FIELDS, SIG_VALUE, 'relaxed');
  const s = createSign('RSA-SHA256');
  s.update(input);
  s.end();
  return s.sign(privateKey).toString('base64');
}

test('R-6376-3.7-b: a valid signature verifies; a tampered signed header fails (skipSignatureCheck caught)', () => {
  cites('R-6376-3.7-b');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const b = sign(privateKey);

  // Intact: recompute the same input and verify.
  const input = buildSigningInput(FIELDS, SIG_VALUE, 'relaxed');
  assert.ok(verifySignature(input, b, publicKey, 'RSA-SHA256'), 'the intact message verifies');

  // Tamper a signed header value; the input changes, so the signature no longer verifies.
  const tampered = buildSigningInput(
    [{ name: 'From', value: 'attacker@example.com' }, FIELDS[1]!, FIELDS[2]!],
    SIG_VALUE,
    'relaxed',
  );
  assert.ok(!verifySignature(tampered, b, publicKey, 'RSA-SHA256'), 'a tampered signed header fails verification');

  // Negative control: skipping the check accepts the tampered message.
  assert.ok(verifySignature(tampered, b, publicKey, 'RSA-SHA256', { skipSignatureCheck: true }), 'skipSignatureCheck must be detectable');
});

test('the "b=" value is emptied before hashing, and only the DKIM-Signature field loses its trailing CRLF', () => {
  const input = buildSigningInput(FIELDS, SIG_VALUE, 'relaxed').toString('latin1');
  // The signed data fields are each CRLF-terminated.
  assert.ok(input.includes('from:alice@example.com\r\n'), 'signed fields are canonicalized + CRLF-terminated');
  // The DKIM-Signature field is present, ends the input, and carries no trailing CRLF.
  assert.ok(input.includes('dkim-signature:'), 'the DKIM-Signature field is included');
  assert.ok(!input.endsWith('\r\n'), 'the DKIM-Signature field has no trailing CRLF');
  assert.ok(/b=(;|$)/.test(input), 'the b= value is emptied in the hashed input');
});
