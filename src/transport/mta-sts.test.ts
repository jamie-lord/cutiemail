/**
 * The MTA-STS corpus (RFC 8461 §3.2/§4.1), with negative controls. Each case proves
 * conformant parsing/matching AND that the matching defect — which would weaken TLS
 * enforcement or MX validation — is DETECTED. Cases cite compile-checked
 * TransportRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStsPolicy, mxMatches } from './mta-sts.ts';
import { transportRequirement } from '../register/transport/index.ts';
import type { TransportRequirementId } from '../register/transport/index.ts';

const P = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: TransportRequirementId): void => assert.ok(transportRequirement(id).id === id);

const POLICY = 'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmx: *.example.net\r\nmax_age: 604800\r\n';

test('sanity: a well-formed policy parses into its fields', () => {
  const p = parseStsPolicy(P(POLICY));
  assert.ok(p.valid);
  assert.equal(p.version, 'STSv1');
  assert.equal(p.mode, 'enforce');
  assert.deepEqual([...p.mx], ['mail.example.com', '*.example.net']);
  assert.equal(p.maxAge, 604800);
});

test('R-8461-3.2-a: the version must be STSv1 (acceptAnyVersion caught)', () => {
  cites('R-8461-3.2-a');
  assert.ok(!parseStsPolicy(P('version: STSv2\r\nmode: enforce\r\nmax_age: 1\r\n')).valid, 'a non-STSv1 version is rejected');
  assert.ok(parseStsPolicy(P('version: STSv2\r\nmode: enforce\r\nmax_age: 1\r\n'), { acceptAnyVersion: true }).valid, 'acceptAnyVersion must be detectable');
});

test('R-8461-3.2-b: the mode must be one of enforce/testing/none (acceptUnknownMode caught)', () => {
  cites('R-8461-3.2-b');
  for (const m of ['enforce', 'testing', 'none']) {
    assert.ok(parseStsPolicy(P(`version: STSv1\r\nmode: ${m}\r\nmax_age: 1\r\n`)).valid, `${m} is a valid mode`);
  }
  assert.ok(!parseStsPolicy(P('version: STSv1\r\nmode: bogus\r\nmax_age: 1\r\n')).valid, 'an unknown mode is rejected');
  assert.ok(parseStsPolicy(P('version: STSv1\r\nmode: bogus\r\nmax_age: 1\r\n'), { acceptUnknownMode: true }).valid, 'acceptUnknownMode must be detectable');
});

test('R-8461-4.1-a: a wildcard matches exactly one left-most label (wildcardMatchesMultipleLabels caught)', () => {
  cites('R-8461-4.1-a');
  // The RFC's own examples: "*.example.com" matches "mail.example.com" but not the others.
  assert.ok(mxMatches('*.example.com', 'mail.example.com'), 'one label matches');
  assert.ok(!mxMatches('*.example.com', 'example.com'), 'the bare domain does not match');
  assert.ok(!mxMatches('*.example.com', 'foo.bar.example.com'), 'two labels do not match');
  assert.ok(mxMatches('mail.example.com', 'mail.example.com'), 'an exact pattern matches');
  // Negative control: a wildcard spanning multiple labels would admit an attacker MX.
  assert.ok(mxMatches('*.example.com', 'evil.attacker.example.com', { wildcardMatchesMultipleLabels: true }), 'wildcardMatchesMultipleLabels must be detectable');
});
