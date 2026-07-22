/**
 * The DMARC record parsing + alignment corpus (RFC 7489 §6.3/§3.1.1), with
 * negative controls. Each case proves conformant behaviour AND that the matching
 * defect — which opens a spoofing hole or misreads a policy — is DETECTED. Cases
 * cite compile-checked AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDmarcRecord, checkAlignment } from './dmarc.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const D = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);
/** A crude Organizational Domain: the last two labels. Real DMARC needs the PSL. */
const orgDomain = (d: string): string => d.split('.').slice(-2).join('.');

test('sanity: a typical DMARC record parses into policy + alignment modes', () => {
  const r = parseDmarcRecord(D('v=DMARC1; p=reject; sp=quarantine; adkim=s; aspf=r; pct=100'));
  assert.ok(r.valid);
  assert.equal(r.policy, 'reject');
  assert.equal(r.subdomainPolicy, 'quarantine');
  assert.equal(r.adkim, 's');
  assert.equal(r.aspf, 'r');
});

test('R-7489-6.3-a: v and p must be present and ordered (acceptMissingPolicy caught)', () => {
  cites('R-7489-6.3-a');
  assert.ok(parseDmarcRecord(D('v=DMARC1; p=none')).valid, 'v then p is valid');
  assert.ok(!parseDmarcRecord(D('v=DMARC1; rua=mailto:x@example.com')).valid, 'a record with no p is invalid');
  assert.ok(!parseDmarcRecord(D('p=reject; v=DMARC1')).valid, 'p before v is invalid');
  // Negative control: accepting a policy-less record.
  assert.ok(parseDmarcRecord(D('v=DMARC1; rua=mailto:x@example.com'), { acceptMissingPolicy: true }).valid, 'acceptMissingPolicy must be detectable');
});

test('R-7489-6.3-b: an unknown tag is ignored, not fatal (failOnUnknownTag caught)', () => {
  cites('R-7489-6.3-b');
  const withUnknown = D('v=DMARC1; p=none; futuretag=whatever');
  assert.ok(parseDmarcRecord(withUnknown).valid, 'an unknown tag does not invalidate the record');
  assert.equal(parseDmarcRecord(withUnknown).policy, 'none', 'the known tags still stand');
  // Negative control.
  assert.ok(!parseDmarcRecord(withUnknown, { failOnUnknownTag: true }).valid, 'failOnUnknownTag must be detectable');
});

test('R-7489-3.1.1-a: strict alignment needs an exact FQDN match (strictUsesOrgDomain caught)', () => {
  cites('R-7489-3.1.1-a');
  // From news.example.com, DKIM d=example.com.
  const from = 'news.example.com';
  const auth = 'example.com';
  // Relaxed: Organizational Domains match -> aligned.
  assert.ok(checkAlignment(from, auth, 'r', orgDomain), 'relaxed aligns via Organizational Domain');
  // Strict: FQDNs differ -> NOT aligned.
  assert.ok(!checkAlignment(from, auth, 's', orgDomain), 'strict requires an exact FQDN match');
  // Exact match is aligned in both modes.
  assert.ok(checkAlignment('example.com', 'example.com', 's', orgDomain));
  // Negative control: strict using org-domain matching would wrongly align a subdomain.
  assert.ok(checkAlignment(from, auth, 's', orgDomain, { strictUsesOrgDomain: true }), 'strictUsesOrgDomain must be detectable');
});

test('alignment normalizes IDN to A-labels so a U-label From matches an A-label d= (RFC 6376 §3.5)', () => {
  // An IDN From is commonly written with U-labels while DKIM d= / SPF are A-labels on the wire.
  // The old raw lower-case compare made the two encodings unequal, false-failing legit IDN mail
  // (junked under p=quarantine/reject). Both identifiers are now punycoded before comparison.
  const uLabel = 'bücher.example';
  const aLabel = 'xn--bcher-kva.example';
  assert.ok(checkAlignment(uLabel, aLabel, 's', orgDomain), 'strict: U-label From vs A-label d= aligns');
  assert.ok(checkAlignment(aLabel, uLabel, 's', orgDomain), 'strict: the reverse pairing aligns too');
  assert.ok(checkAlignment(uLabel, aLabel, 'r', orgDomain), 'relaxed aligns as well');
  // Control: two genuinely different IDNs must NOT align (no over-broad normalization).
  assert.ok(!checkAlignment(uLabel, 'xn--nxasmq6b.example', 's', orgDomain), 'a different IDN is not aligned');
});
