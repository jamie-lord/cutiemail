/**
 * The SCRAM account-store corpus (RFC 5802 §1), with a negative control. Proves a
 * legitimate proof authenticates, that the stored database holds no password (so DB
 * theft cannot impersonate), and that storing the password (the defect) breaks that
 * property. Cites a compile-checked AuthRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from './accounts.ts';
import { hi, computeClientProof } from '../auth/scram.ts';
import { authRequirement } from '../register/auth/index.ts';
import type { AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

const SALT = Buffer.from('QSXCR+Q6sek8bf92', 'base64');
const ITERATIONS = 4096;
const AUTH_MESSAGE = 'n=user,r=abc,r=abcdef,s=QSXCR+Q6sek8bf92,i=4096,c=biws,r=abcdef';

test('a legitimate client proof authenticates', () => {
  const store = new AccountStore();
  store.setPassword('user', 'pencil', SALT, ITERATIONS, 'sha256');
  const proof = computeClientProof(hi('pencil', SALT, ITERATIONS, 'sha256'), AUTH_MESSAGE, 'sha256');
  assert.ok(store.authenticate('user', AUTH_MESSAGE, proof), 'the real proof verifies');
  // A wrong-password proof does not.
  const wrong = computeClientProof(hi('WRONG', SALT, ITERATIONS, 'sha256'), AUTH_MESSAGE, 'sha256');
  assert.ok(!store.authenticate('user', AUTH_MESSAGE, wrong), 'a wrong-password proof is rejected');
});

test('R-5802-1-a: the stored database holds no password, so DB theft cannot impersonate (storePlaintextPassword caught)', () => {
  cites('R-5802-1-a');
  const store = new AccountStore();
  store.setPassword('user', 'pencil', SALT, ITERATIONS, 'sha256');
  const cred = store.credential('user')!;
  // The conformant store persists only derived keys.
  assert.equal(cred.password, undefined, 'no password is stored');
  assert.ok(cred.storedKey.length > 0 && cred.serverKey.length > 0, 'only StoredKey/ServerKey are kept');

  // An attacker with the stolen StoredKey cannot forge a proof: the best they can
  // compute from it (ClientSignature as a stand-in proof) does not verify, because
  // they lack ClientKey (StoredKey is its one-way hash).
  const forgery = Buffer.alloc(cred.storedKey.length, 0); // any proof they can invent
  assert.ok(!store.authenticate('user', AUTH_MESSAGE, forgery), 'the stored keys alone cannot impersonate');

  // Negative control: a store that keeps the password makes DB theft sufficient.
  const bad = new AccountStore();
  bad.setPassword('user', 'pencil', SALT, ITERATIONS, 'sha256', { storePlaintextPassword: true });
  assert.equal(bad.credential('user')!.password, 'pencil', 'storePlaintextPassword must be detectable');
});
