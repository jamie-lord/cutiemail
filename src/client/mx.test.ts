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
