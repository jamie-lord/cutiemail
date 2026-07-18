/**
 * Inbound ARC validation (RFC 8617 §5.2), with negative controls.
 *
 * A local test SEALER (addArcSet) signs real ARC Sets with generated RSA/Ed25519 keys,
 * exactly as an intermediary would, so verifyArc can be driven end-to-end against a
 * genuinely-sealed message with an injected key resolver — the same round-trip discipline
 * the DKIM suite uses. Each §5.2 failure mode (broken seal, altered body → newest AMS,
 * a gap, a cv=fail, a missing field, a wrong key) has a test that DETECTS it: cv must be
 * "fail" (or "none"), never a false "pass".
 *
 * The AS ordering itself is independently pinned by the golden test in crypto/arc-seal.test.ts;
 * this file proves the whole §5.2 algorithm and its wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyArc } from './arc-inbound.ts';
import { makeArcSigner, addArcSet, arcResolver, rawMessageOf as rawOf, type HeaderLine } from '../testing/arc-sealer.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const makeSigner = makeArcSigner;
const resolverFor = arcResolver;

const BASE_HEADERS: readonly HeaderLine[] = [
  { name: 'From', value: 'Alice <alice@origin.example>' },
  { name: 'To', value: 'bob@dest.example' },
  { name: 'Subject', value: 'hello' },
  { name: 'Date', value: 'Tue, 15 Jul 2026 10:00:00 +0000' },
];

const BODY = 'This is the message body.\r\n';

test('no ARC headers → cv=none (not a failure)', async () => {
  const out = await verifyArc(rawOf(BASE_HEADERS, BODY), async () => null);
  assert.equal(out.cv, 'none');
  assert.equal(out.instances, 0);
});

test('a valid one-hop RSA chain (i=1, cv=none) → cv=pass, outermost sealer surfaced', async () => {
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', []);
  const raw = rawOf([...hop.lines, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'pass');
  assert.equal(out.instances, 1);
  assert.equal(out.outermostSealer, 'forwarder.example');
});

test('a valid two-hop chain (i=1 none, i=2 pass), Ed25519 sealers → cv=pass', async () => {
  const s1 = makeSigner('list.example', 'k1', 'ed25519');
  const s2 = makeSigner('relay.example', 'k2', 'ed25519');
  const hop1 = addArcSet(BASE_HEADERS, BODY, s1, 1, 'none', 'dmarc=pass', []);
  // Hop 2 seals over the message that already carries hop 1's set.
  const withHop1 = [...hop1.lines, ...BASE_HEADERS];
  const hop2 = addArcSet(withHop1, BODY, s2, 2, 'pass', 'dmarc=pass', [hop1.set]);
  const raw = rawOf([...hop2.lines, ...withHop1], BODY);
  const out = await verifyArc(raw, resolverFor(s1, s2));
  assert.equal(out.cv, 'pass');
  assert.equal(out.instances, 2);
  assert.equal(out.outermostSealer, 'relay.example');
  assert.deepEqual([...out.sealDomains], ['list.example', 'relay.example']);
});

test('NEGATIVE: altering the body after sealing fails the newest AMS → cv=fail (§5.2 step 4)', async () => {
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', []);
  const raw = rawOf([...hop.lines, ...BASE_HEADERS], BODY + 'injected extra line\r\n');
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'fail');
});

test('NEGATIVE: tampering a sealed ARC-Seal signature → cv=fail (§5.2 step 6)', async () => {
  cites('R-8617-5.2-c'); // every AS from N..1 must validate; a broken seal fails the chain
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', []);
  const brokenSeal = { name: 'ARC-Seal', value: hop.set.as.slice(0, -4) + (hop.set.as.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  const raw = rawOf([brokenSeal, hop.lines[1]!, hop.lines[2]!, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'fail');
});

test('NEGATIVE: a gap in the instance sequence (1,3) → cv=fail (§5.2 step 3.B)', async () => {
  const s1 = makeSigner('list.example', 'k1', 'rsa');
  const s3 = makeSigner('relay.example', 'k3', 'rsa');
  const hop1 = addArcSet(BASE_HEADERS, BODY, s1, 1, 'none', 'dmarc=pass', []);
  const withHop1 = [...hop1.lines, ...BASE_HEADERS];
  const hop3 = addArcSet(withHop1, BODY, s3, 3, 'pass', 'dmarc=pass', [hop1.set]); // jumps to 3
  const raw = rawOf([...hop3.lines, ...withHop1], BODY);
  const out = await verifyArc(raw, resolverFor(s1, s3));
  assert.equal(out.cv, 'fail');
});

test('NEGATIVE: the newest seal carries cv=fail → cv=fail immediately (§5.2 step 2)', async () => {
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  // i=1 with cv=fail is itself a structural violation AND the step-2 short-circuit.
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'fail', 'dmarc=fail', []);
  const raw = rawOf([...hop.lines, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'fail');
});

test('NEGATIVE: the newest AMS does not sign From → cv=fail (mirror the DKIM From guard, run-3)', async () => {
  // ARC-Seal signs only the ARC sets, not From; if the AMS h= omits From then a cv=pass chain
  // leaves the displayed sender unprotected — a spoof could ride the ARC rescue past a
  // p=reject DMARC failure. The AMS must sign From, exactly as the inbound DKIM path requires.
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', [], 'to:subject:date'); // From omitted
  const raw = rawOf([...hop.lines, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'fail', 'an AMS that does not sign From must not yield cv=pass');
});

test('NEGATIVE: an incomplete set (AMS missing) → cv=fail (§5.2 step 3.A)', async () => {
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', []);
  // Drop the ARC-Message-Signature line.
  const raw = rawOf([hop.lines[0]!, hop.lines[2]!, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, resolverFor(sg));
  assert.equal(out.cv, 'fail');
});

test('NEGATIVE: the sealer key is not in DNS → cv=fail, never temperror (§5.2.1 all failures permanent)', async () => {
  const sg = makeSigner('forwarder.example', 'arc1', 'rsa');
  const hop = addArcSet(BASE_HEADERS, BODY, sg, 1, 'none', 'dmarc=pass', []);
  const raw = rawOf([...hop.lines, ...BASE_HEADERS], BODY);
  const out = await verifyArc(raw, async () => null); // no key published
  assert.equal(out.cv, 'fail');
});
