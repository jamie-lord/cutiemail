/**
 * The SMTP AUTH state-machine corpus (RFC 4954 §4 + ADR 0007), with negative
 * controls. A reference decision function over session state, testable before the
 * live submission server. Cites compile-checked AuthRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAuth } from './auth-state.ts';
import type { SessionState } from './auth-state.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);
const state = (over: Partial<SessionState> = {}): SessionState => ({ tlsActive: true, authenticated: false, inTransaction: false, ...over });

test('sanity: AUTH is accepted on a fresh TLS session', () => {
  const d = canAuth(state());
  assert.ok(d.accepted && d.code === 334);
});

test('R-4954-4-a: AUTH is rejected during a mail transaction (allowAuthInTransaction caught)', () => {
  cites('R-4954-4-a');
  const d = canAuth(state({ inTransaction: true }));
  assert.ok(!d.accepted && d.code === 503, 'AUTH during a transaction gets 503');
  // Negative control.
  assert.ok(canAuth(state({ inTransaction: true }), { allowAuthInTransaction: true }).accepted, 'allowAuthInTransaction must be detectable');
});

test('R-4954-4-b: a second AUTH is rejected (allowReauth caught)', () => {
  cites('R-4954-4-b');
  const d = canAuth(state({ authenticated: true }));
  assert.ok(!d.accepted && d.code === 503, 'a second AUTH gets 503');
  // Negative control.
  assert.ok(canAuth(state({ authenticated: true }), { allowReauth: true }).accepted, 'allowReauth must be detectable');
});

test('ADR 0007: AUTH is refused on a cleartext connection (allowCleartextAuth caught)', () => {
  cites('R-4954-4-b');
  const d = canAuth(state({ tlsActive: false }));
  assert.ok(!d.accepted && d.code === 538, 'no plaintext AUTH — encryption required first');
  // Negative control: permitting cleartext AUTH.
  assert.ok(canAuth(state({ tlsActive: false }), { allowCleartextAuth: true }).accepted, 'allowCleartextAuth must be detectable');
});
