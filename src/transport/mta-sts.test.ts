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

test('max_age accepts only RFC 8461 §3.2 digits, and is clamped to the stated ceiling', () => {
  const age = (v: string): number | null => parseStsPolicy(P(`version: STSv1\r\nmode: enforce\r\nmax_age: ${v}\r\n`)).maxAge;

  // Grammatical values pass through unchanged.
  assert.equal(age('604800'), 604800);
  assert.equal(age('0'), 0);

  // ...and are clamped at one year (§3.2 "maximum value of 31557600"). A 10-digit value is
  // grammatical under the section's own 1*10(DIGIT) but is 317x the prose ceiling.
  assert.equal(age('31557600'), 31_557_600, 'exactly the ceiling is kept');
  assert.equal(age('31557601'), 31_557_600, 'one past it is clamped, not rejected');
  assert.equal(age('9999999999'), 31_557_600, 'grammatical-but-absurd is clamped');

  // Number() would accept all of these; the digit grammar does not. 1e308 is the dangerous one:
  // unclamped it yields expiresAt = Infinity, a policy that can never age out.
  for (const bad of ['1e308', '1E3', '0x7fffffff', '0b101', '0o17', '+5', '-1', '1.5', '', '99999999999999999999']) {
    assert.equal(age(bad), null, `${JSON.stringify(bad)} is not 1*10(DIGIT)`);
  }
});
