/**
 * ARC-Seal signing-input + signature (RFC 8617 §5.1.1, §5.2 step 6), with negative controls.
 *
 * The seal reuses the RFC 6376-vector-pinned buildSigningInput, so the only NEW logic is
 * the ARC header ORDERING and the b=-emptied/no-trailing-CRLF rule for the sealing AS.
 * The first test pins exactly that with a GOLDEN byte string derived by hand from the
 * §5.1.1 + §3.4.2 (relaxed) rules — an independent check that a symmetric sign/verify bug
 * cannot hide behind. The rest are RSA + Ed25519 round-trips whose tampers are the
 * negative controls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { buildSealInput, verifySeal, signSeal, type ArcSetHeaders } from './arc-seal.ts';
import { rawPublicKey } from './dkim-ed25519.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);
const set = (instance: number, aar: string, ams: string, as: string): ArcSetHeaders => ({ instance, aar, ams, as });

test('GOLDEN §5.1.1: one-set seal input = relaxed(AAR)+CRLF, relaxed(AMS)+CRLF, relaxed(AS, b= emptied, no CRLF)', () => {
  cites('R-8617-4.1.3-a'); // no body hash — the seal signs only header fields
  cites('R-8617-4.1.3-b'); // relaxed canonicalization only
  cites('R-8617-5.1.1-b'); // per-set order: AAR, AMS, AS
  const sets = [set(1, 'i=1; a.example; dkim=pass', 'i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAA', 'i=1; a=rsa-sha256; cv=none; d=a.example; s=s1; b=BBBB')];
  const expected =
    'arc-authentication-results:i=1; a.example; dkim=pass\r\n' +
    'arc-message-signature:i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAA\r\n' +
    'arc-seal:i=1; a=rsa-sha256; cv=none; d=a.example; s=s1; b='; // b= emptied, NO trailing CRLF
  assert.equal(buildSealInput(sets, 1).toString('latin1'), expected);
});

test('GOLDEN §5.1.1: two-set seal input orders sets 1 then 2, prior AS kept intact, sealing AS emptied', () => {
  cites('R-8617-5.1.1-a'); // increasing instance order, including the set being sealed
  const sets = [
    set(1, 'i=1; a.example; dkim=pass', 'i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAA', 'i=1; a=rsa-sha256; cv=none; d=a.example; s=s1; b=BBBB'),
    set(2, 'i=2; b.example; dkim=fail', 'i=2; a=rsa-sha256; h=from; bh=YmFy; b=CCCC', 'i=2; a=rsa-sha256; cv=pass; d=b.example; s=s2; b=DDDD'),
  ];
  const expected =
    'arc-authentication-results:i=1; a.example; dkim=pass\r\n' +
    'arc-message-signature:i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAA\r\n' +
    'arc-seal:i=1; a=rsa-sha256; cv=none; d=a.example; s=s1; b=BBBB\r\n' + // prior seal: b= kept
    'arc-authentication-results:i=2; b.example; dkim=fail\r\n' +
    'arc-message-signature:i=2; a=rsa-sha256; h=from; bh=YmFy; b=CCCC\r\n' +
    'arc-seal:i=2; a=rsa-sha256; cv=pass; d=b.example; s=s2; b='; // sealing AS: emptied, no CRLF
  assert.equal(buildSealInput(sets, 2).toString('latin1'), expected);
  // Validating the earlier seal (instance 1) covers only set 1.
  assert.equal(buildSealInput(sets, 1).toString('latin1'), buildSealInput([sets[0]!], 1).toString('latin1'));
});

test('§5.1.1: a seal excludes any set added after it (instance > sealInstance)', () => {
  const sets = [
    set(1, 'i=1; x', 'i=1; b=AAAA', 'i=1; cv=none; b=BBBB'),
    set(2, 'i=2; y', 'i=2; b=CCCC', 'i=2; cv=pass; b=DDDD'),
  ];
  // The seal at instance 1 must be identical whether or not set 2 is present.
  assert.equal(buildSealInput(sets, 1).toString('latin1'), buildSealInput([sets[0]!], 1).toString('latin1'));
});

test('round-trip: an RSA seal we sign verifies; a one-bit body change to the sealed set fails (negative control)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const asNoB = 'i=1; a=rsa-sha256; cv=none; d=a.example; s=s1; b=';
  const sets = [set(1, 'i=1; a.example; dkim=pass', 'i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAA', asNoB)];
  const b = signSeal(buildSealInput(sets, 1), 'rsa', privateKey);

  assert.equal(verifySeal(buildSealInput(sets, 1), b, 'rsa', pub), true, 'the seal we signed must verify');

  // Negative control: mutate a byte of the sealed AMS — the same signature must now fail.
  const tampered = [set(1, sets[0]!.aar, 'i=1; a=rsa-sha256; h=from; bh=Zm9v; b=AAAB', asNoB)];
  assert.equal(verifySeal(buildSealInput(tampered, 1), b, 'rsa', pub), false, 'a tampered set must not verify under the old seal');
});

test('round-trip: an Ed25519 seal (RFC 8463 alg) verifies; wrong key fails (negative control)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  const asNoB = 'i=1; a=ed25519-sha256; cv=none; d=a.example; s=s1; b=';
  const sets = [set(1, 'i=1; a.example; dkim=pass', 'i=1; a=ed25519-sha256; h=from; bh=Zm9v; b=AAAA', asNoB)];
  const b = signSeal(buildSealInput(sets, 1), 'ed25519', privateKey);

  assert.equal(verifySeal(buildSealInput(sets, 1), b, 'ed25519', pub), true);

  // Negative control: a different key must reject the signature.
  const other = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
  assert.equal(verifySeal(buildSealInput(sets, 1), b, 'ed25519', other), false);
});
