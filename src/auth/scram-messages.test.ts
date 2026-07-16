/**
 * The SCRAM message-exchange corpus (RFC 5802 §5.1), with negative controls. Uses
 * the RFC 5802 §5 example messages, and proves the nonce-continuation checks that
 * prevent splice/replay are enforced. Cites compile-checked AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientFirst, parseServerFirst, parseClientFinal, verifyServerNonce, verifyClientNonce } from './scram-messages.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const M = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

// RFC 5802 §5 example.
const CLIENT_FIRST = 'n,,n=user,r=fyko+d2lbbFgONRv9qkxdawL';
const SERVER_FIRST = 'r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096';
const CLIENT_FINAL = 'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=';

test('sanity: the three RFC 5802 §5 messages parse into their attributes', () => {
  const cf = parseClientFirst(M(CLIENT_FIRST));
  assert.equal(cf.gs2Header, 'n,,');
  assert.equal(cf.username, 'user');
  assert.equal(cf.nonce, 'fyko+d2lbbFgONRv9qkxdawL');

  const sf = parseServerFirst(M(SERVER_FIRST));
  assert.equal(sf.salt, 'QSXCR+Q6sek8bf92');
  assert.equal(sf.iterations, 4096);

  const cfin = parseClientFinal(M(CLIENT_FINAL));
  assert.equal(cfin.channelBinding, 'biws');
  assert.equal(cfin.proof, 'v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=');
});

test('R-5802-5.1-a: the client verifies the server nonce continues its own (skipNonceCheck caught)', () => {
  cites('R-5802-5.1-a');
  const client = parseClientFirst(M(CLIENT_FIRST));
  const server = parseServerFirst(M(SERVER_FIRST));
  assert.ok(verifyServerNonce(client.nonce, server.nonce), 'the server nonce begins with the client nonce');
  // A server nonce that does not start with the client nonce is a splice.
  assert.ok(!verifyServerNonce(client.nonce, 'ATTACKERnonce3rfcNHYJY1ZVvWVs7j'), 'a non-continuing nonce is rejected');
  // A server that adds nothing is also rejected.
  assert.ok(!verifyServerNonce(client.nonce, client.nonce), 'the server must add its own nonce');
  // Negative control.
  assert.ok(verifyServerNonce(client.nonce, 'ATTACKERnonce', { skipNonceCheck: true }), 'skipNonceCheck must be detectable');
});

test('R-5802-5.1-b: the server verifies the client-final nonce equals the one it issued (acceptMismatchedNonce caught)', () => {
  cites('R-5802-5.1-b');
  const server = parseServerFirst(M(SERVER_FIRST));
  const clientFinal = parseClientFinal(M(CLIENT_FINAL));
  assert.ok(verifyClientNonce(server.nonce, clientFinal.nonce), 'the client echoed the full server nonce');
  assert.ok(!verifyClientNonce(server.nonce, 'fyko+d2lbbFgONRv9qkxdawLDIFFERENT'), 'a mismatched nonce is rejected');
  // Negative control.
  assert.ok(verifyClientNonce(server.nonce, 'totally-different', { acceptMismatchedNonce: true }), 'acceptMismatchedNonce must be detectable');
});
