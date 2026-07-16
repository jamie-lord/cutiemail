/**
 * The SMTP SIZE-enforcement corpus (RFC 1870), with negative controls. Proves an
 * over-limit message is rejected 552 and that enforcement is against the actual
 * bytes (not the client's declaration), with each rule's defect DETECTED. Cites
 * compile-checked TransportRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceSize } from './size.ts';
import { transportRequirement } from '../register/transport/index.ts';
import type { TransportRequirementId } from '../register/transport/index.ts';

const cites = (id: TransportRequirementId): void => assert.ok(transportRequirement(id).id === id);
const MAX = 1000;

test('sanity: a within-limit message is accepted', () => {
  assert.equal(enforceSize(500, 500, MAX).code, 250);
  assert.equal(enforceSize(null, 999, MAX).code, 250);
});

test('R-1870-6.1-a: an over-limit message is rejected 552 (ignoreSizeLimit caught)', () => {
  cites('R-1870-6.1-a');
  // Declared over the limit — rejected up front.
  assert.equal(enforceSize(5000, 5000, MAX).code, 552, 'an over-limit declaration is rejected 552');
  // No declaration, but the actual bytes exceed the limit.
  assert.equal(enforceSize(null, 5000, MAX).code, 552, 'over-limit actual bytes are rejected 552');
  // Negative control.
  assert.ok(enforceSize(5000, 5000, MAX, { ignoreSizeLimit: true }).accepted, 'ignoreSizeLimit must be detectable');
});

test('R-1870-6-a: enforcement uses the actual size, not the declaration (trustDeclaredSize caught)', () => {
  cites('R-1870-6-a');
  // A client under-declares (100) but sends 5000; the server must catch the actual size.
  assert.equal(enforceSize(100, 5000, MAX).code, 552, 'the actual oversized bytes are caught despite a small declaration');
  // Negative control: trusting the declaration lets the oversized message through.
  assert.ok(enforceSize(100, 5000, MAX, { trustDeclaredSize: true }).accepted, 'trustDeclaredSize must be detectable');
});
