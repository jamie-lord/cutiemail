/**
 * IP-literal parsing/classification helpers. These back the SSRF guard's private-address check
 * and the auth throttle's /64 keying, so the cases that matter are the non-canonical IPv6 spellings
 * that a textual (regex/prefix) check misses but the parsed value must not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipv6Hextets, embeddedV4, throttleKey } from './ip.ts';

test('ipv6Hextets collapses every spelling of the same address to the same 8 hextets', () => {
  const loopbackMapped = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001];
  // All of these denote ::ffff:127.0.0.1 — canonical, zero-expanded, fully-expanded, dotted.
  for (const s of ['::ffff:127.0.0.1', '0::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '0000::ffff:7f00:1', '::ffff:7f00:1']) {
    assert.deepEqual(ipv6Hextets(s), loopbackMapped, `${s} parses to ::ffff:127.0.0.1`);
  }
  assert.deepEqual(ipv6Hextets('::1'), [0, 0, 0, 0, 0, 0, 0, 1], 'loopback');
  assert.deepEqual(ipv6Hextets('::'), [0, 0, 0, 0, 0, 0, 0, 0], 'unspecified');
  assert.deepEqual(ipv6Hextets('fe80::1'), [0xfe80, 0, 0, 0, 0, 0, 0, 1], 'link-local');
  assert.deepEqual(ipv6Hextets('[2001:db8::1]%eth0'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], 'brackets + zone stripped');
  assert.equal(ipv6Hextets('not:an:ip'), null, 'garbage is rejected');
  assert.equal(ipv6Hextets('1::2::3'), null, 'more than one :: is rejected');
});

test('embeddedV4 decodes mapped/compatible forms (incl. ::1 / ::) and nothing else', () => {
  assert.equal(embeddedV4([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]), '127.0.0.1', 'mapped');
  assert.equal(embeddedV4([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe]), '169.254.169.254', 'mapped metadata');
  assert.equal(embeddedV4([0, 0, 0, 0, 0, 0, 0, 1]), '0.0.0.1', '::1 decodes to 0.0.0.1');
  assert.equal(embeddedV4([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]), null, 'a global address has no embedded v4');
});

test('throttleKey aggregates IPv6 to /64 and keeps IPv4 (and mapped) whole', () => {
  // Every host address in one /64 collapses to the same key — the fix for the rotation evasion.
  const a = throttleKey('2001:db8:abcd:1234:0:0:0:1');
  const b = throttleKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
  assert.equal(a, b, 'two addresses in the same /64 share a throttle key');
  assert.notEqual(a, throttleKey('2001:db8:abcd:9999::1'), 'a different /64 is a different key');
  assert.equal(throttleKey('203.0.113.5'), '203.0.113.5', 'IPv4 keys on the full address');
  assert.equal(throttleKey('::ffff:203.0.113.5'), '203.0.113.5', 'IPv4-mapped keys on the embedded v4');
  assert.equal(throttleKey(''), '', 'empty stays empty (fail-safe per-source)');
});
