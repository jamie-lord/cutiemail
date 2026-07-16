/**
 * The SPF record parsing/evaluation corpus (RFC 7208 §4.5/§4.6.2), with negative
 * controls. Each case proves conformant behaviour AND that the matching defect —
 * which flips an authorization decision — is DETECTED. Cases cite compile-checked
 * AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpfRecord, evaluateSpf } from './spf.ts';
import type { SpfTerm } from './spf.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const S = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);
const matchAll = (_t: SpfTerm): boolean => true;

test('sanity: a typical record parses into version + qualified terms', () => {
  const r = parseSpfRecord(S('v=spf1 +mx a:colo.example.com/28 -all'));
  assert.ok(r.valid);
  assert.equal(r.version, 'v=spf1');
  assert.equal(r.terms.length, 3);
  assert.deepEqual(
    r.terms.map((t) => [t.qualifier, t.mechanism]),
    [['+', 'mx'], ['+', 'a'], ['-', 'all']],
  );
});

test('R-7208-4.5-a: only exactly "v=spf1" is a valid version (acceptAnyVersion caught)', () => {
  cites('R-7208-4.5-a');
  assert.ok(parseSpfRecord(S('v=spf1 -all')).valid, 'v=spf1 is valid');
  const spf10 = parseSpfRecord(S('v=spf10 -all'));
  assert.ok(!spf10.valid, 'v=spf10 is discarded, not treated as spf1');
  assert.equal(evaluateSpf(spf10, matchAll), 'none', 'a discarded record evaluates to none');
  // Negative control: accepting any version treats v=spf10 as a real record.
  const defect = parseSpfRecord(S('v=spf10 -all'), { acceptAnyVersion: true });
  assert.ok(defect.valid, 'acceptAnyVersion must be detectable');
});

test('R-7208-4.6.2-a: mechanisms evaluate left to right, first match wins (lastMatchWins caught)', () => {
  cites('R-7208-4.6.2-a');
  // Both +ip4 and -all "match" (all always matches); left-to-right, +ip4 wins -> pass.
  const r = parseSpfRecord(S('v=spf1 +ip4:1.2.3.4 -all'));
  assert.equal(evaluateSpf(r, matchAll), 'pass', 'the leftmost matching mechanism wins');
  // Negative control: evaluating right-to-left makes -all win -> fail.
  assert.equal(evaluateSpf(r, matchAll, { lastMatchWins: true }), 'fail', 'lastMatchWins must be detectable');
});

test('R-7208-4.6.2-b: a qualifier-less mechanism defaults to "+" pass (defaultQualifierNeutral caught)', () => {
  cites('R-7208-4.6.2-b');
  // Bare "mx" -> default "+" -> a match yields pass.
  const r = parseSpfRecord(S('v=spf1 mx -all'));
  assert.equal(r.terms[0]!.qualifier, '+', 'the default qualifier is "+"');
  assert.equal(evaluateSpf(r, (t) => t.mechanism === 'mx'), 'pass', 'a bare mx match is a pass');
  // The qualifier mapping across all four.
  assert.equal(evaluateSpf(parseSpfRecord(S('v=spf1 -all')), matchAll), 'fail', '"-" is fail');
  assert.equal(evaluateSpf(parseSpfRecord(S('v=spf1 ~all')), matchAll), 'softfail', '"~" is softfail');
  assert.equal(evaluateSpf(parseSpfRecord(S('v=spf1 ?all')), matchAll), 'neutral', '"?" is neutral');
  // Negative control: defaulting to neutral downgrades the bare-mx pass.
  const defect = parseSpfRecord(S('v=spf1 mx -all'), { defaultQualifierNeutral: true });
  assert.equal(evaluateSpf(defect, (t) => t.mechanism === 'mx'), 'neutral', 'defaultQualifierNeutral must be detectable');
});
