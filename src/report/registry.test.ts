/**
 * The cross-register inventory's integrity checks. Not a conformance corpus — a
 * consistency gate over the whole register: the summary counts must agree with the
 * registers themselves, every domain must draw from at least one RFC, and the level
 * counts must add up. This is what keeps the "what the register holds" claim honest
 * as domains are added.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistrySummary, renderRegistrySummary } from './registry.ts';
import { REQUIREMENTS as SMTP } from '../register/rfc5321.ts';
import { MESSAGE_REQUIREMENTS as MESSAGE } from '../register/message/index.ts';
import { CRYPTO_REQUIREMENTS as CRYPTO } from '../register/crypto/index.ts';
import { IMAP_REQUIREMENTS as IMAP } from '../register/imap/index.ts';
import { AUTH_REQUIREMENTS as AUTH } from '../register/auth/index.ts';
import { TRANSPORT_REQUIREMENTS as TRANSPORT } from '../register/transport/index.ts';

test('the summary total equals the sum of every register', () => {
  const s = buildRegistrySummary();
  const expected = SMTP.length + MESSAGE.length + CRYPTO.length + IMAP.length + AUTH.length + TRANSPORT.length;
  assert.equal(s.totalRequirements, expected, 'no requirement is miscounted or dropped');
  assert.equal(s.domains.length, 6, 'all six domains are present');
});

test('each domain draws from at least one RFC and its level counts add up', () => {
  const s = buildRegistrySummary();
  for (const d of s.domains) {
    assert.ok(d.rfcs.length >= 1, `${d.name} cites at least one RFC`);
    const levelTotal = Object.values(d.byLevel).reduce((a, b) => a + b, 0);
    assert.equal(levelTotal, d.requirementCount, `${d.name} level counts sum to its requirement count`);
    const testTotal = Object.values(d.byTestability).reduce((a, b) => a + b, 0);
    assert.equal(testTotal, d.requirementCount, `${d.name} testability counts sum to its requirement count`);
  }
});

test('the rendering names every domain', () => {
  const text = renderRegistrySummary(buildRegistrySummary());
  for (const name of ['smtp', 'message', 'crypto', 'imap', 'auth', 'transport']) {
    assert.ok(text.includes(name), `the report names ${name}`);
  }
});
