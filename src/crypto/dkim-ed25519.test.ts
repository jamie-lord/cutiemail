/**
 * The DKIM Ed25519 corpus (RFC 8463), with a negative control. Ground truth is the
 * RFC 8463 §A keypair (from RFC 8032 §7.1 Test 1): the public key our code derives
 * from the published secret key must equal the published public key. Then a full
 * sign → verify round-trip over the §3.7 header hash input. Cites a compile-checked
 * CryptoRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importEd25519PrivateKey, rawPublicKey, signEd25519, verifyEd25519 } from './dkim-ed25519.ts';
import { createPublicKey } from 'node:crypto';
import { buildSigningInput } from './dkim-verify.ts';
import type { SignedField } from './dkim-verify.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

// RFC 8463 §A vector.
const RFC_SECRET = Buffer.from('nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=', 'base64');
const RFC_PUBLIC = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

const FIELDS: SignedField[] = [
  { name: 'From', value: 'joe@football.example.com' },
  { name: 'Subject', value: 'Is dinner ready?' },
];
const SIG_VALUE = 'v=1; a=ed25519-sha256; c=relaxed/relaxed; d=football.example.com; s=brisbane; h=from:subject; bh=irrelevant=; b=';

test('the RFC 8463 vector binds: the derived public key equals the published one', () => {
  const priv = importEd25519PrivateKey(RFC_SECRET);
  assert.equal(rawPublicKey(createPublicKey(priv)), RFC_PUBLIC, 'derived public key matches RFC 8463 §A.2');
});

test('R-8463-3-a: an ed25519-sha256 signature round-trips; a tampered message fails (skipCheck caught)', () => {
  cites('R-8463-3-a');
  const priv = importEd25519PrivateKey(RFC_SECRET);
  const pub = createPublicKey(priv);

  const input = buildSigningInput(FIELDS, SIG_VALUE, 'relaxed');
  const b = signEd25519(input, priv);
  assert.ok(verifyEd25519(input, b, pub), 'the intact message verifies under Ed25519');

  // Tamper a signed header: the input changes, so the signature no longer verifies.
  const tampered = buildSigningInput([{ name: 'From', value: 'attacker@evil.example' }, FIELDS[1]!], SIG_VALUE, 'relaxed');
  assert.ok(!verifyEd25519(tampered, b, pub), 'a tampered message fails Ed25519 verification');

  // Negative control.
  assert.ok(verifyEd25519(tampered, b, pub, { skipCheck: true }), 'skipCheck must be detectable');
});
