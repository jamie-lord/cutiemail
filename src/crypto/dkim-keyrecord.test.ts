/**
 * The DKIM public-key record corpus (RFC 6376 §3.6.1), with negative controls.
 * Ground truth includes the RFC 8463 §A.2 published key records. Each case proves
 * conformant parsing AND that the matching defect — which would honour a
 * wrong-version or revoked key — is DETECTED. Cites compile-checked
 * CryptoRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDkimKeyRecord } from './dkim-keyrecord.ts';
import { importEd25519PublicKey, verifyEd25519, signEd25519, importEd25519PrivateKey } from './dkim-ed25519.ts';
import { buildSigningInput } from './dkim-verify.ts';
import type { SignedField } from './dkim-verify.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const K = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

// RFC 8463 §A.2 published key records.
const ED25519_RECORD = 'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

test('sanity: the RFC 8463 §A.2 key records parse', () => {
  const ed = parseDkimKeyRecord(K(ED25519_RECORD));
  assert.ok(ed.valid);
  assert.equal(ed.keyType, 'ed25519');
  assert.equal(ed.publicKey, '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=');
  // Default key type is rsa when k= is absent.
  assert.equal(parseDkimKeyRecord(K('v=DKIM1; p=AAAA')).keyType, 'rsa');
});

test('R-6376-3.6.1-a: a non-DKIM1 version record is discarded (acceptAnyVersion caught)', () => {
  cites('R-6376-3.6.1-a');
  assert.ok(!parseDkimKeyRecord(K('v=DKIM2; k=rsa; p=AAAA')).valid, 'a v=DKIM2 record is discarded');
  assert.ok(!parseDkimKeyRecord(K('k=rsa; v=DKIM1; p=AAAA')).valid, 'v= must be first');
  // Negative control.
  assert.ok(parseDkimKeyRecord(K('v=DKIM2; k=rsa; p=AAAA'), { acceptAnyVersion: true }).valid, 'acceptAnyVersion must be detectable');
});

test('R-6376-3.6.1-b: an empty p= is a revoked key, unusable (treatEmptyPAsValid caught)', () => {
  cites('R-6376-3.6.1-b');
  const revoked = parseDkimKeyRecord(K('v=DKIM1; k=ed25519; p='));
  assert.ok(revoked.revoked, 'an empty p= marks the key revoked');
  assert.ok(!revoked.valid, 'a revoked key is not usable for verification');
  assert.ok(!parseDkimKeyRecord(K('v=DKIM1; k=rsa')).valid, 'a record with no p= at all is invalid');
  // Negative control.
  assert.ok(parseDkimKeyRecord(K('v=DKIM1; k=ed25519; p='), { treatEmptyPAsValid: true }).valid, 'treatEmptyPAsValid must be detectable');
});

test('end-to-end: the public key parsed from the record verifies an Ed25519 signature', () => {
  cites('R-6376-3.6.1-b');
  // Import the public key straight out of the parsed record and verify a signature.
  const rec = parseDkimKeyRecord(K(ED25519_RECORD));
  assert.ok(rec.publicKey !== null);
  const pub = importEd25519PublicKey(Buffer.from(rec.publicKey!, 'base64'));

  const priv = importEd25519PrivateKey(Buffer.from('nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=', 'base64'));
  const fields: SignedField[] = [{ name: 'From', value: 'joe@football.example.com' }];
  const input = buildSigningInput(fields, 'v=1; a=ed25519-sha256; c=relaxed/relaxed; d=football.example.com; s=brisbane; h=from; bh=x; b=', 'relaxed');
  const b = signEd25519(input, priv);
  assert.ok(verifyEd25519(input, b, pub), 'the key from the DNS record verifies the signature');
});
