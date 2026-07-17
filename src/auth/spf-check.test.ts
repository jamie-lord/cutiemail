/**
 * Inbound SPF evaluation (RFC 7208). Drives the async recursive evaluator with an
 * injected DNS map (no network), covering the mechanisms real senders publish and the
 * §4.6.4 lookup limit that stops a hostile record fanning the resolver into a DoS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpf, type SpfResolvers } from './spf-check.ts';

function resolvers(txt: Record<string, string[]>, a: Record<string, string[]> = {}, mx: Record<string, string[]> = {}): SpfResolvers {
  return {
    txt: async (n) => txt[n] ?? [],
    a: async (n) => a[n] ?? [],
    mx: async (n) => mx[n] ?? [],
  };
}

test('ip4 / ip6 CIDR mechanisms with the qualifier applied', async () => {
  const r = resolvers({ 'ex.test': ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'] });
  assert.equal(await checkSpf('192.0.2.5', 'ex.test', r), 'pass', 'in the v4 range');
  assert.equal(await checkSpf('198.51.100.1', 'ex.test', r), 'fail', 'out of range hits -all');
  assert.equal(await checkSpf('2001:db8::abcd', 'ex.test', r), 'pass', 'in the v6 range');
  assert.equal(await checkSpf('2001:dead::1', 'ex.test', r), 'fail', 'out of the v6 range');
});

test('the qualifier determines the result (pass / fail / softfail / neutral)', async () => {
  assert.equal(await checkSpf('10.0.0.1', 'e.test', resolvers({ 'e.test': ['v=spf1 -all'] })), 'fail');
  assert.equal(await checkSpf('10.0.0.1', 'e.test', resolvers({ 'e.test': ['v=spf1 ~all'] })), 'softfail');
  assert.equal(await checkSpf('10.0.0.1', 'e.test', resolvers({ 'e.test': ['v=spf1 ?all'] })), 'neutral');
  assert.equal(await checkSpf('10.0.0.1', 'e.test', resolvers({ 'e.test': ['v=spf1 +all'] })), 'pass');
  assert.equal(await checkSpf('10.0.0.1', 'e.test', resolvers({ 'e.test': ['v=spf1 ip4:1.2.3.0/24'] })), 'neutral', 'no match, no all → neutral');
});

test('a and mx mechanisms default to the current domain and resolve via DNS', async () => {
  const r = resolvers({ 'ex.test': ['v=spf1 a mx -all'] }, { 'ex.test': ['203.0.113.7'], 'mail.ex.test': ['203.0.113.9'] }, { 'ex.test': ['mail.ex.test'] });
  assert.equal(await checkSpf('203.0.113.7', 'ex.test', r), 'pass', 'a: matches the domain address');
  assert.equal(await checkSpf('203.0.113.9', 'ex.test', r), 'pass', 'mx: matches an MX host address');
  assert.equal(await checkSpf('203.0.113.50', 'ex.test', r), 'fail', 'a non-listed IP falls through to -all');
});

test('include: matches only when the referenced policy passes; redirect= takes over', async () => {
  const inc = resolvers({ 'ex.test': ['v=spf1 include:_spf.p.test -all'], '_spf.p.test': ['v=spf1 ip4:192.0.2.0/24 -all'] });
  assert.equal(await checkSpf('192.0.2.5', 'ex.test', inc), 'pass', 'the included policy passes');
  assert.equal(await checkSpf('10.0.0.1', 'ex.test', inc), 'fail', 'the included policy does not pass → -all');

  const red = resolvers({ 'ex.test': ['v=spf1 redirect=_spf.p.test'], '_spf.p.test': ['v=spf1 ip4:192.0.2.0/24 -all'] });
  assert.equal(await checkSpf('192.0.2.5', 'ex.test', red), 'pass', 'redirect delegates to the target policy');
  assert.equal(await checkSpf('10.0.0.1', 'ex.test', red), 'fail');
});

test('no SPF record is "none"; a DNS error is "temperror"; two records is "permerror"', async () => {
  assert.equal(await checkSpf('192.0.2.5', 'bare.test', resolvers({})), 'none');
  assert.equal(await checkSpf('192.0.2.5', 'dup.test', resolvers({ 'dup.test': ['v=spf1 -all', 'v=spf1 +all'] })), 'permerror', 'multiple records is an error');
  const throwing: SpfResolvers = {
    txt: async () => {
      throw new Error('SERVFAIL');
    },
    a: async () => [],
    mx: async () => [],
  };
  assert.equal(await checkSpf('192.0.2.5', 'x.test', throwing), 'temperror');
});

test('the RFC 7208 §4.6.4 DNS-lookup limit is enforced (DoS guard)', async () => {
  const txt: Record<string, string[]> = {};
  let record = 'v=spf1';
  for (let i = 0; i < 11; i++) {
    record += ` include:i${i}.test`;
    txt[`i${i}.test`] = ['v=spf1 -all'];
  }
  txt['big.test'] = [`${record} -all`];
  assert.equal(await checkSpf('192.0.2.5', 'big.test', resolvers(txt)), 'permerror', '11 include lookups exceed the limit');
});

test('a null domain or an unparseable IP is "none"', async () => {
  assert.equal(await checkSpf('192.0.2.5', '', resolvers({})), 'none', 'empty domain');
  assert.equal(await checkSpf('not-an-ip', 'ex.test', resolvers({ 'ex.test': ['v=spf1 -all'] })), 'none', 'bad IP');
});
