/**
 * The ARC chain-structure corpus (RFC 8617 §5.2), with negative controls. Proves
 * the structural validation that must hold before ARC signature crypto — continuous
 * instances and consistent cv values — with each rule's defect DETECTED. Cites
 * compile-checked AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArcChainStructure } from './arc.ts';
import type { ArcSet } from './arc.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);
const set = (instance: number, cv: ArcSet['cv']): ArcSet => ({ instance, cv, hasAAR: true, hasAMS: true, hasAS: true });

test('sanity: a two-hop chain with i=1 none, i=2 pass validates', () => {
  const r = validateArcChainStructure([set(1, 'none'), set(2, 'pass')]);
  assert.equal(r.status, 'pass');
  assert.deepEqual([...r.anomalies], []);
  // No chain at all is "none", not a failure.
  assert.equal(validateArcChainStructure([]).status, 'none');
});

test('R-8617-5.2-a: instances must form a continuous 1..N sequence (acceptGaps caught)', () => {
  cites('R-8617-5.2-a');
  // A gap (1, 3) breaks continuity.
  assert.equal(validateArcChainStructure([set(1, 'none'), set(3, 'pass')]).status, 'fail', 'a gap fails the chain');
  // A repeat (1, 1) too.
  assert.equal(validateArcChainStructure([set(1, 'none'), set(1, 'none')]).status, 'fail', 'a repeat fails the chain');
  // Negative control.
  assert.equal(validateArcChainStructure([set(1, 'none'), set(3, 'pass')], { acceptGaps: true }).status, 'pass', 'acceptGaps must be detectable');
});

test('R-8617-5.2-b: cv must be none at i=1, pass after, never fail (acceptWrongCv caught)', () => {
  cites('R-8617-5.2-b');
  // i=1 must be none, not pass.
  assert.equal(validateArcChainStructure([set(1, 'pass')]).status, 'fail', 'i=1 with cv=pass is wrong');
  // A cv=fail anywhere fails the chain.
  assert.equal(validateArcChainStructure([set(1, 'none'), set(2, 'fail')]).status, 'fail', 'a cv=fail fails the chain');
  // i>1 must be pass, not none.
  assert.equal(validateArcChainStructure([set(1, 'none'), set(2, 'none')]).status, 'fail', 'i=2 with cv=none is wrong');
  // Negative control.
  assert.equal(validateArcChainStructure([set(1, 'pass')], { acceptWrongCv: true }).status, 'pass', 'acceptWrongCv must be detectable');
});
