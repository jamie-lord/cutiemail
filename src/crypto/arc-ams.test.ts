/**
 * The ARC-Message-Signature corpus (RFC 8617 §4.1.2), with a negative control. AMS
 * verification reuses the DKIM machinery, so the test signs an AMS with a real RSA
 * key and proves an intact message verifies while a tampered one fails. Cites a
 * compile-checked CryptoRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { buildAmsInput, verifyAms } from './arc-ams.ts';
import type { SignedField } from './dkim-verify.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const FIELDS: SignedField[] = [
  { name: 'From', value: 'alice@example.com' },
  { name: 'Subject', value: 'via a mailing list' },
];
// An ARC-Message-Signature value (b= empty at signing time), i= the ARC instance.
const AMS_VALUE = 'i=1; a=rsa-sha256; c=relaxed/relaxed; d=lists.example.org; s=arc; h=from:subject; bh=irrelevant=; b=';

test('R-8617-4.1.2-a: an AMS verifies like a DKIM signature; a tampered message fails', () => {
  cites('R-8617-4.1.2-a');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const input = buildAmsInput(FIELDS, AMS_VALUE, 'relaxed');
  const s = createSign('RSA-SHA256');
  s.update(input);
  s.end();
  const b = s.sign(privateKey).toString('base64');

  assert.ok(verifyAms(FIELDS, AMS_VALUE, b, publicKey), 'the intact AMS verifies');

  // Tamper a signed header — the AMS no longer verifies.
  const tampered: SignedField[] = [{ name: 'From', value: 'attacker@evil.example' }, FIELDS[1]!];
  assert.ok(!verifyAms(tampered, AMS_VALUE, b, publicKey), 'a tampered message fails AMS verification');
});
