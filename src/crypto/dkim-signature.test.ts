/**
 * The DKIM-Signature tag-list corpus (RFC 6376 §3.5), with negative controls.
 * Each case proves the parse gate accepts a well-formed tag-list AND enforces one
 * structural rule, with the matching defect DETECTED. Cases cite compile-checked
 * CryptoRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDkimSignature, hasSignatureAnomaly } from './dkim-signature.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const H = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

// A complete, well-formed DKIM-Signature tag-list (all seven required tags).
const GOOD = 'v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; bh=AbC123=; b=SiGvAlUe=';

test('sanity: a complete tag-list parses into its fields', () => {
  const sig = parseDkimSignature(H(GOOD));
  assert.ok(sig.valid);
  assert.equal(sig.domain, 'example.com');
  assert.equal(sig.selector, 'sel');
  assert.equal(sig.algorithm, 'rsa-sha256');
  assert.deepEqual([...sig.signedHeaders], ['from', 'to', 'subject']);
});

test('R-6376-3.5-a: a duplicate tag invalidates the whole list (acceptDuplicateTags caught)', () => {
  cites('R-6376-3.5-a');
  const dup = `${GOOD}; d=evil.example`; // d= appears twice
  assert.ok(!parseDkimSignature(H(dup)).valid, 'a duplicate tag invalidates the signature');
  assert.ok(hasSignatureAnomaly(parseDkimSignature(H(dup)), 'duplicate-tag'));
  // Negative control: last-wins merge.
  assert.ok(parseDkimSignature(H(dup), { acceptDuplicateTags: true }).valid, 'acceptDuplicateTags must be detectable');
});

test('R-6376-3.5-b: an unknown tag is ignored, not fatal (failOnUnknownTag caught)', () => {
  cites('R-6376-3.5-b');
  const withUnknown = `${GOOD}; futuretag=whatever`;
  assert.ok(parseDkimSignature(H(withUnknown)).valid, 'an unknown tag does not invalidate the signature');
  assert.equal(parseDkimSignature(H(withUnknown)).domain, 'example.com', 'the known tags still stand');
  // Negative control.
  assert.ok(!parseDkimSignature(H(withUnknown), { failOnUnknownTag: true }).valid, 'failOnUnknownTag must be detectable');
});

test('R-6376-3.5-c: a missing required tag invalidates the signature (acceptMissingRequiredTag caught)', () => {
  cites('R-6376-3.5-c');
  // Drop the b= (signature) tag.
  const noB = 'v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=AbC123=';
  assert.ok(!parseDkimSignature(H(noB)).valid, 'a signature missing b= is invalid');
  assert.ok(hasSignatureAnomaly(parseDkimSignature(H(noB)), 'missing-required-tag'));
  // Negative control.
  assert.ok(parseDkimSignature(H(noB), { acceptMissingRequiredTag: true }).valid, 'acceptMissingRequiredTag must be detectable');
});
