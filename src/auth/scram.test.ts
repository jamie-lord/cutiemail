/**
 * The SCRAM corpus (RFC 5802 §3), with negative controls. Its ground truth is the
 * RFC 5802 §5 worked example (user 'user', password 'pencil') — the ClientProof and
 * ServerSignature are the spec's own published values, so the crypto is checked
 * against the standard, not just our implementation. Cites compile-checked
 * AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hi, storedKey, computeClientProof, computeServerSignature, verifyClientProof } from './scram.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

// RFC 5802 §5 worked example (SCRAM-SHA-1).
const PASSWORD = 'pencil';
const SALT = Buffer.from('QSXCR+Q6sek8bf92', 'base64');
const ITERATIONS = 4096;
const AUTH_MESSAGE =
  'n=user,r=fyko+d2lbbFgONRv9qkxdawL' +
  ',r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096' +
  ',c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j';
const RFC_CLIENT_PROOF = 'v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=';
const RFC_SERVER_SIGNATURE = 'rmF9pqV8S7suAoZWja4dJRkFsKQ=';

const salted = (): Buffer => hi(PASSWORD, SALT, ITERATIONS, 'sha1');

test('R-5802-3-a: the client proof matches the RFC 5802 vector; the server verifies it (skipProofCheck caught)', () => {
  cites('R-5802-3-a');
  const proof = computeClientProof(salted(), AUTH_MESSAGE, 'sha1');
  assert.equal(proof.toString('base64'), RFC_CLIENT_PROOF, 'the computed ClientProof is the RFC vector');

  // Server-side verification against the stored key it would persist.
  const stored = storedKey(salted(), 'sha1');
  assert.ok(verifyClientProof(stored, AUTH_MESSAGE, proof, 'sha1'), 'the server accepts a correct proof');

  // A wrong password produces a proof the server rejects.
  const wrongProof = computeClientProof(hi('WRONG', SALT, ITERATIONS, 'sha1'), AUTH_MESSAGE, 'sha1');
  assert.ok(!verifyClientProof(stored, AUTH_MESSAGE, wrongProof, 'sha1'), 'a wrong-password proof is rejected');

  // Negative control: skipping the check accepts even the wrong proof.
  assert.ok(verifyClientProof(stored, AUTH_MESSAGE, wrongProof, 'sha1', { skipProofCheck: true }), 'skipProofCheck must be detectable');
});

test('R-5802-3-b: the server signature matches the RFC 5802 vector', () => {
  cites('R-5802-3-b');
  const sig = computeServerSignature(salted(), AUTH_MESSAGE, 'sha1');
  assert.equal(sig.toString('base64'), RFC_SERVER_SIGNATURE, 'the computed ServerSignature is the RFC vector');
  // A different AuthMessage yields a different signature (so a client would reject a forged server).
  assert.notEqual(computeServerSignature(salted(), `${AUTH_MESSAGE},x`, 'sha1').toString('base64'), RFC_SERVER_SIGNATURE);
});

test('the same construction works under SHA-256 (the production choice)', () => {
  // No RFC-5802 vector for SHA-256 here, but the round-trip must hold: a proof the
  // client computes is one the server verifies.
  const s = hi(PASSWORD, SALT, ITERATIONS, 'sha256');
  const proof = computeClientProof(s, AUTH_MESSAGE, 'sha256');
  assert.ok(verifyClientProof(storedKey(s, 'sha256'), AUTH_MESSAGE, proof, 'sha256'), 'SHA-256 round-trip verifies');
});
