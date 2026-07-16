/**
 * The DKIM body-hash corpus (RFC 6376 §3.7), with a negative control. This is real
 * crypto: the "expected" hash is computed by the reference canon + node:crypto, and
 * the case proves a matching body verifies while a tampered one fails — and that
 * skipping the check (the defect) is detectable. Cites a compile-checked
 * CryptoRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBodyHash, verifyBodyHash } from './dkim-bodyhash.ts';
import { parseDkimSignature } from './dkim-signature.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const B = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const BODY = B('Hello, DKIM!\r\nSecond line.\r\n');

/** Build a parsed signature whose bh= is the correct relaxed/sha256 hash of `body`. */
function signatureFor(body: Buffer): ReturnType<typeof parseDkimSignature> {
  const bh = computeBodyHash(body, 'relaxed', 'sha256');
  return parseDkimSignature(B(`v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=sel; h=from; bh=${bh}; b=AAAA`));
}

test('sanity: the body hash is a stable base64 SHA-256 of the canonicalized body', () => {
  const h1 = computeBodyHash(BODY, 'relaxed', 'sha256');
  const h2 = computeBodyHash(BODY, 'relaxed', 'sha256');
  assert.equal(h1, h2, 'deterministic');
  assert.match(h1, /^[A-Za-z0-9+/]+=*$/, 'base64');
  // simple vs relaxed differ for a body with trailing whitespace.
  assert.notEqual(computeBodyHash(B('a \r\n'), 'simple', 'sha256'), computeBodyHash(B('a \r\n'), 'relaxed', 'sha256'));
});

test('R-6376-3.7-a: a matching body verifies; a tampered body fails (skipBodyHashCheck caught)', () => {
  cites('R-6376-3.7-a');
  const sig = signatureFor(BODY);
  assert.ok(verifyBodyHash(BODY, sig).ok, 'the intact body matches its bh=');

  // Tamper: flip a byte of the body. The hash no longer matches.
  const tampered = Buffer.concat([B('Hello, DKIM?\r\nSecond line.\r\n')]);
  assert.ok(!verifyBodyHash(tampered, sig).ok, 'a tampered body fails the body-hash check');

  // Negative control: skipping the check accepts the tampered body.
  assert.ok(verifyBodyHash(tampered, sig, { skipBodyHashCheck: true }).ok, 'skipBodyHashCheck must be detectable');
});

test('R-6376-3.5-d: l= limits the hashed length and must not exceed the body (acceptOverlongL caught)', () => {
  cites('R-6376-3.5-d');
  // Canonicalize the body and pick an l= covering only its first part.
  const prefix = B('signed part\r\n');
  const full = Buffer.concat([prefix, B('APPENDED UNSIGNED CONTENT\r\n')]);
  // The l= value is the octet length of the canonicalized signed prefix (relaxed
  // leaves this simple line unchanged).
  const canonPrefixLen = prefix.length;
  const bh = computeBodyHash(full, 'relaxed', 'sha256', canonPrefixLen);
  const sig = parseDkimSignature(B(`v=1; a=rsa-sha256; c=relaxed/relaxed; d=e.com; s=s; h=from; l=${canonPrefixLen}; bh=${bh}; b=AAAA`));

  // The signature verifies over the full message (l= covers only the prefix).
  assert.ok(verifyBodyHash(full, sig).ok, 'l= limits the hash to the signed prefix');

  // SECURITY (§8.2): appending MORE content past l= still verifies — the append attack.
  const moreAppended = Buffer.concat([full, B('and even more\r\n')]);
  assert.ok(verifyBodyHash(moreAppended, sig).ok, 'content appended past l= is unsigned (the documented l= risk)');

  // But an l= LARGER than the body is a violation.
  const bodyLen = Buffer.from('signed part\r\n', 'latin1').length + Buffer.from('APPENDED UNSIGNED CONTENT\r\n', 'latin1').length;
  const overlong = parseDkimSignature(B(`v=1; a=rsa-sha256; c=relaxed/relaxed; d=e.com; s=s; h=from; l=${bodyLen + 100}; bh=${bh}; b=AAAA`));
  assert.ok(!verifyBodyHash(full, overlong).lengthValid, 'an l= larger than the body is rejected');
  // Negative control.
  assert.ok(verifyBodyHash(full, overlong, { acceptOverlongL: true }).lengthValid, 'acceptOverlongL must be detectable');
});
