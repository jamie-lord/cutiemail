/**
 * Alias + subaddress resolution (ADR 0014). resolveLocalPart is THE routing chokepoint —
 * inbound RCPT acceptance, delivery, and bounce-routing all go through it — so its precedence
 * (login > alias > subaddress), case-insensitivity, disabled-owner handling, and refusal of
 * anything not ours (no catch-all) are pinned here, each with its negative control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRegistry } from './account-registry.ts';
import { openMailDb } from './open-mail-db.ts';

function registry(): AccountRegistry {
  const reg = AccountRegistry.open(openMailDb(':memory:'));
  reg.upsert('alice', 'pw', ':memory:', { iterations: 1 });
  reg.upsert('Bob', 'pw', ':memory:', { iterations: 1 }); // mixed-case login (identity keeps case)
  return reg;
}

test('exact login resolves case-insensitively and returns the canonical case', () => {
  const reg = registry();
  assert.equal(reg.resolveLocalPart('alice'), 'alice');
  assert.equal(reg.resolveLocalPart('ALICE'), 'alice');
  assert.equal(reg.resolveLocalPart('bob'), 'Bob', 'canonical-case login is returned, not the query');
  assert.equal(reg.resolveLocalPart('nobody'), undefined, 'an unknown local-part is not ours');
});

test('an alias resolves to its owning login, case-insensitively', () => {
  const reg = registry();
  reg.addAlias('sales', 'alice');
  assert.equal(reg.resolveLocalPart('sales'), 'alice');
  assert.equal(reg.resolveLocalPart('Sales'), 'alice');
  assert.equal(reg.aliasesFor('alice').includes('sales'), true);
});

test('subaddressing (base+tag) delivers to the base — for a login or an alias', () => {
  const reg = registry();
  reg.addAlias('sales', 'alice');
  assert.equal(reg.resolveLocalPart('alice+github'), 'alice', 'tag on a login');
  assert.equal(reg.resolveLocalPart('sales+q3'), 'alice', 'tag on an alias');
  assert.equal(reg.resolveLocalPart('alice+a+b'), 'alice', 'only the first + splits; the rest is the tag');
  assert.equal(reg.resolveLocalPart('+tag'), undefined, 'an empty base is not a subaddress');
  assert.equal(reg.resolveLocalPart('nobody+tag'), undefined, 'a tag cannot conjure an unknown base');
});

test('a disabled owner resolves to nothing — via login, alias, or subaddress (no silent drop)', () => {
  const reg = registry();
  reg.addAlias('sales', 'alice');
  reg.setEnabled('alice', false);
  assert.equal(reg.resolveLocalPart('alice'), undefined);
  assert.equal(reg.resolveLocalPart('sales'), undefined, 'an alias to a disabled account does not deliver');
  assert.equal(reg.resolveLocalPart('alice+x'), undefined);
  // Re-enabling restores every path.
  reg.setEnabled('alice', true);
  assert.equal(reg.resolveLocalPart('sales'), 'alice');
});

test('nameTaken spans both namespaces; removeAlias stops resolution', () => {
  const reg = registry();
  reg.addAlias('sales', 'alice');
  assert.equal(reg.nameTaken('alice'), 'login');
  assert.equal(reg.nameTaken('BOB'), 'login');
  assert.equal(reg.nameTaken('sales'), 'alias');
  assert.equal(reg.nameTaken('SALES'), 'alias');
  assert.equal(reg.nameTaken('free'), undefined);

  assert.equal(reg.removeAlias('sales'), true);
  assert.equal(reg.removeAlias('sales'), false, 'removing a gone alias reports false');
  assert.equal(reg.resolveLocalPart('sales'), undefined, 'a removed alias no longer resolves');
});
