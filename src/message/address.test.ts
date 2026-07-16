/**
 * The addr-spec (RFC 5322 §3.4.1) conformance corpus, with negative controls.
 *
 * Proves the opinionated parser accepts modern addresses, rejects the malformed and
 * obsolete forms, and that each rejection is a REAL detection (a defect that accepts
 * the bad address is caught). Cases cite compile-checked MessageRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddrSpec } from './address.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const a = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

test('sanity: ordinary modern addresses parse into local-part + domain', () => {
  for (const s of ['user@example.com', 'a.b+c@sub.example.com', 'x@[192.0.2.1]']) {
    const r = parseAddrSpec(a(s));
    assert.ok(r.ok, `${s} should parse`);
  }
  const r = parseAddrSpec(a('user@example.com'));
  assert.ok(r.ok && r.addr.localPart.toString('latin1') === 'user' && r.addr.domain.toString('latin1') === 'example.com');
});

test('R-5322-3.4.1-a: the local@domain structure is enforced (and the empty-sides defect is caught)', () => {
  cites('R-5322-3.4.1-a');
  assert.ok(!parseAddrSpec(a('@example.com')).ok, 'empty local-part is rejected');
  assert.ok(!parseAddrSpec(a('user@')).ok, 'empty domain is rejected');
  assert.ok(!parseAddrSpec(a('userexample.com')).ok, 'a missing @ is rejected');
  assert.ok(!parseAddrSpec(a('a@b@c')).ok, 'more than one @ is rejected');

  // Negative control: accepting empty sides must be detectable.
  assert.ok(parseAddrSpec(a('@example.com'), { acceptEmptySides: true }).ok, 'acceptEmptySides must be detectable');
});

test('R-5322-3.4.1-b: a quoted local-part is accepted but surfaced as an anomaly', () => {
  cites('R-5322-3.4.1-b');
  const r = parseAddrSpec(a('"weird name"@example.com'));
  assert.ok(r.ok, 'a well-formed quoted local-part is legal');
  assert.ok(r.ok && r.addr.anomalies.includes('quoted-local-part'), 'the quoted form is recorded (dot-atom is preferred)');
});

test('R-5322-3.4.1-c: whitespace/comments around the @ are rejected (opinionated modern cut)', () => {
  cites('R-5322-3.4.1-c');
  // A space or a comment paren is non-atext in a dot-atom local-part, so both are rejected.
  assert.ok(!parseAddrSpec(a('user @example.com')).ok, 'folding white space before @ is rejected');
  assert.ok(!parseAddrSpec(a('user(comment)@example.com')).ok, 'a comment around @ is rejected');

  // Negative control: the same permissive defect (accept non-atext) accepts them.
  assert.ok(parseAddrSpec(a('user @example.com'), { acceptInvalidLocalChars: true }).ok, 'acceptInvalidLocalChars must be detectable');
});

test('local-part length floor (RFC 5321 §4.5.3.1.1): 64 accepted, 65 rejected, defect caught', () => {
  cites('R-5322-3.4.1-a');
  assert.ok(parseAddrSpec(a(`${'x'.repeat(64)}@example.com`)).ok, 'a 64-octet local-part is at the floor');
  assert.ok(!parseAddrSpec(a(`${'x'.repeat(65)}@example.com`)).ok, 'a 65-octet local-part exceeds the floor');
  assert.ok(parseAddrSpec(a(`${'x'.repeat(65)}@example.com`), { acceptOverlongLocalPart: true }).ok, 'acceptOverlongLocalPart must be detectable');
});
