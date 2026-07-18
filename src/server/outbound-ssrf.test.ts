/**
 * SSRF guard on outbound MX targets (audit finding). An attacker who controls a
 * recipient domain's DNS can publish "MX 0 127.0.0.1" (or a private/link-local address,
 * or "localhost") to make the relay open a port-25 connection to an internal host. A
 * public domain's MX is never legitimately loopback/private, so those targets are
 * refused. This pins which literals are treated as unsafe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsafeMxTarget, resolvesToPrivate } from './outbound.ts';

test('loopback, private, link-local, and localhost MX targets are refused', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.5.5', '172.31.255.1', '192.168.1.1', '169.254.1.1', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'localhost', 'mx.localhost', 'LOCALHOST']) {
    assert.equal(isUnsafeMxTarget(h), true, `${h} must be refused`);
  }
});

test('public MX hostnames and public IP literals are allowed', () => {
  for (const h of ['gmail-smtp-in.l.google.com', 'aspmx.l.google.com', 'mx1.example.com', 'mail.protonmail.ch', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2001:4860:4860::8888']) {
    assert.equal(isUnsafeMxTarget(h), false, `${h} must be allowed`);
  }
});

test('a hostname that RESOLVES to a private address is refused (the residual is now closed)', async () => {
  // The literal-form check passes an innocent-looking hostname; the pre-connect resolution
  // is what catches it. Inject the resolver so the test needs no live DNS.
  const resolvesTo = (addrs: string[]) => async (): Promise<readonly string[]> => addrs;
  assert.equal(await resolvesToPrivate('mx.attacker.test', resolvesTo(['127.0.0.1'])), true, 'loopback');
  assert.equal(await resolvesToPrivate('mx.attacker.test', resolvesTo(['169.254.169.254'])), true, 'cloud-metadata link-local');
  assert.equal(await resolvesToPrivate('mx.attacker.test', resolvesTo(['10.0.0.5'])), true, 'private 10/8');
  assert.equal(await resolvesToPrivate('mx.attacker.test', resolvesTo(['93.184.216.34', '10.0.0.5'])), true, 'ANY private address refuses');
});

test('a hostname resolving only to public addresses is allowed; a literal IP is left to isUnsafeMxTarget', async () => {
  const resolvesTo = (addrs: string[]) => async (): Promise<readonly string[]> => addrs;
  assert.equal(await resolvesToPrivate('mx1.example.com', resolvesTo(['93.184.216.34'])), false, 'public address is fine');
  assert.equal(await resolvesToPrivate('mx1.example.com', async () => { throw new Error('NXDOMAIN'); }), false, 'a resolution failure is not "private"');
  // A literal IP is short-circuited (handled by isUnsafeMxTarget) — resolvesToPrivate never resolves it.
  assert.equal(await resolvesToPrivate('127.0.0.1', async () => { throw new Error('must not be called'); }), false);
});
