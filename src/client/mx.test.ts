/**
 * The MX-resolution corpus (RFC 5321 §5.1), with negative controls. A reference-model
 * test of client-binding requirements the receiver suite cannot observe (cited
 * read-only). DNS is injected, so the ordering is deterministic. Cites compile-checked
 * RequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMxHosts } from './mx.ts';
import type { DnsResolver, MxRecord } from './mx.ts';
import { requirement } from '../register/rfc5321.ts';
import type { RequirementId } from '../register/rfc5321.ts';

const cites = (id: RequirementId): void => assert.ok(requirement(id).id === id);

const dns = (records: Record<string, MxRecord[]>, addresses: string[] = []): DnsResolver => ({
  mx: (d) => records[d] ?? [],
  hasAddress: (d) => addresses.includes(d),
});

test('sanity: no MX but an address record yields the domain as an implicit MX', () => {
  const r = resolveMxHosts('example.com', dns({}, ['example.com']));
  assert.deepEqual([...r.hosts], ['example.com']);
  // Neither MX nor address -> nothing to deliver to.
  assert.deepEqual([...resolveMxHosts('nowhere.example', dns({})).hosts], []);
});

test('RFC 7505 null MX: a single empty/root MX target bounces (never dials host "")', () => {
  // The real resolver surfaces "MX 0 ." as an empty exchange (''); a bare '' host would reach
  // net.connect and dial localhost. Both '' and '.' must normalise to the '.'
  // sentinel the relay bounces on — and it must be exactly one MX (a real MX alongside is not
  // a null MX).
  assert.deepEqual([...resolveMxHosts('nomail.example', dns({ 'nomail.example': [{ host: '', preference: 0 }] })).hosts], ['.'], 'empty exchange → null-MX sentinel');
  assert.deepEqual([...resolveMxHosts('nomail.example', dns({ 'nomail.example': [{ host: '.', preference: 0 }] })).hosts], ['.'], 'literal "." → null-MX sentinel');
  // A genuine single MX is untouched; a null MX joined by a real MX is NOT treated as null.
  assert.deepEqual([...resolveMxHosts('ok.example', dns({ 'ok.example': [{ host: 'mx.ok.example', preference: 10 }] })).hosts], ['mx.ok.example']);
  assert.deepEqual(
    [...resolveMxHosts('mixed.example', dns({ 'mixed.example': [{ host: '', preference: 0 }, { host: 'mx.mixed.example', preference: 10 }] })).hosts],
    ['', 'mx.mixed.example'],
    'two records is not a null MX (the empty one is left for the SSRF backstop to refuse)',
  );
});

test('R-5321-5.1-n: MX records are tried in order of increasing preference (ignorePreference caught)', () => {
  cites('R-5321-5.1-n');
  const records = {
    'example.com': [
      { host: 'backup.example.com', preference: 20 },
      { host: 'primary.example.com', preference: 10 },
    ],
  };
  assert.deepEqual([...resolveMxHosts('example.com', dns(records)).hosts], ['primary.example.com', 'backup.example.com'], 'lowest preference first');
  // Negative control: unsorted uses DNS order.
  assert.deepEqual([...resolveMxHosts('example.com', dns(records), { ignorePreference: true }).hosts], ['backup.example.com', 'primary.example.com'], 'ignorePreference must be detectable');
});

test('R-5321-5.1-g: with MX present, the address record is not used (useAddressWhenMxPresent caught)', () => {
  cites('R-5321-5.1-g');
  const records = { 'example.com': [{ host: 'mx.example.com', preference: 10 }] };
  // The domain also has an A record, but MX present means A is not used.
  assert.deepEqual([...resolveMxHosts('example.com', dns(records, ['example.com'])).hosts], ['mx.example.com'], 'only the MX host, not the A record');
  // Negative control: falling back to the address when MX is present.
  const defect = resolveMxHosts('example.com', dns(records, ['example.com']), { useAddressWhenMxPresent: true });
  assert.ok(defect.hosts.includes('example.com'), 'useAddressWhenMxPresent must be detectable');
});

test('R-5321-5.1-o: equal-preference MX targets are randomized (noEqualPreferenceShuffle caught)', () => {
  cites('R-5321-5.1-o');
  const records = {
    'example.com': [
      { host: 'a.mx.example.com', preference: 10 },
      { host: 'b.mx.example.com', preference: 10 },
    ],
  };
  // Conformant: across many resolutions BOTH orders of the equal-preference tier appear. A tiny
  // deterministic PRNG (mulberry32) keeps the statistics reproducible without a live RNG.
  let seed = 0x9e3779b9;
  const rng = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const orders = new Set<string>();
  for (let i = 0; i < 200; i++) orders.add(resolveMxHosts('example.com', dns(records), {}, rng).hosts.join(','));
  assert.ok(orders.has('a.mx.example.com,b.mx.example.com') && orders.has('b.mx.example.com,a.mx.example.com'), `both orders must appear across resolutions, saw ${JSON.stringify([...orders])}`);

  // Negative control: the noEqualPreferenceShuffle defect keeps DNS order every time.
  const fixed = new Set<string>();
  for (let i = 0; i < 50; i++) fixed.add(resolveMxHosts('example.com', dns(records), { noEqualPreferenceShuffle: true }, rng).hosts.join(','));
  assert.deepEqual([...fixed], ['a.mx.example.com,b.mx.example.com'], 'the defect never randomizes - always DNS order');

  // Randomization is WITHIN a preference tier only: a lower-preference MX still leads, always.
  const tiered = {
    'example.com': [
      { host: 'primary.example.com', preference: 10 },
      { host: 'x.backup.example.com', preference: 20 },
      { host: 'y.backup.example.com', preference: 20 },
    ],
  };
  for (let i = 0; i < 50; i++) {
    const hosts = resolveMxHosts('example.com', dns(tiered), {}, rng).hosts;
    assert.equal(hosts[0], 'primary.example.com', 'the lowest-preference MX is never shuffled below a backup');
  }
});
