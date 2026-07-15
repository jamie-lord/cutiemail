import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineFixture, missingCapabilities, withPostmasterConvention, validateFixture,
} from './fixture.ts';
import type { Fixture } from './fixture.ts';

test('the baseline fixture supplies only the client domain', () => {
  const f = baselineFixture('client.example');
  assert.equal(f.clientDomain, 'client.example');
  assert.equal(f.source, 'none');
  assert.equal(f.validRecipient, undefined);
});

test('missingCapabilities names exactly what a run lacks', () => {
  const f = baselineFixture('c.example');
  assert.deepEqual(missingCapabilities(f, ['validRecipient', 'nonRelayDomain']), [
    'validRecipient',
    'nonRelayDomain',
  ]);
});

test('a declared capability is not reported missing', () => {
  const f: Fixture = { ...baselineFixture('c.example'), validRecipient: 'a@b.example', source: 'operator-declared' };
  assert.deepEqual(missingCapabilities(f, ['validRecipient']), []);
});

test('the postmaster convention fills in only when undeclared', () => {
  const declared: Fixture = {
    ...baselineFixture('c.example'),
    postmaster: 'pm@srv.example',
    source: 'operator-declared',
  };
  assert.equal(withPostmasterConvention(declared, 'srv.example').postmaster, 'pm@srv.example');

  const filled = withPostmasterConvention(baselineFixture('c.example'), 'srv.example');
  assert.equal(filled.postmaster, 'postmaster@srv.example');
  assert.equal(filled.source, 'convention', 'a convention-derived fixture is marked as such');
});

test('validateFixture catches contradictions', () => {
  assert.deepEqual(validateFixture(baselineFixture('c.example')), []);

  const same: Fixture = {
    ...baselineFixture('c.example'),
    validRecipient: 'x@y.example',
    rejectedRecipient: 'x@y.example',
    source: 'operator-declared',
  };
  assert.ok(validateFixture(same).some((p) => p.includes('same address')));

  const notAddr: Fixture = {
    ...baselineFixture('c.example'),
    validRecipient: 'notanaddress',
    source: 'operator-declared',
  };
  assert.ok(validateFixture(notAddr).some((p) => p.includes('not an address')));

  const badSize: Fixture = {
    ...baselineFixture('c.example'),
    declaredSizeLimit: 0,
    source: 'operator-declared',
  };
  assert.ok(validateFixture(badSize).some((p) => p.includes('positive')));
});

test('an empty client domain is rejected', () => {
  assert.ok(validateFixture(baselineFixture('')).some((p) => p.includes('clientDomain')));
});
