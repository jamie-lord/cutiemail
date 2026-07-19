/**
 * The shared From-author extractor (message/from-author.ts). It is the single source of
 * truth for "who is the From", used by both inbound DMARC alignment and outbound submission
 * sender-authorization (ADR 0015), so its spoof-hardening is security-critical: the display-
 * name decoy must resolve to the address the MUA SHOWS, and a second From must be counted so
 * both callers can reject it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorAddrSpec, domainOfAddrSpec, fromAuthor } from './from-author.ts';

test('authorAddrSpec takes the plain angle-addr', () => {
  assert.equal(authorAddrSpec('Alice <alice@example.com>'), 'alice@example.com');
  assert.equal(authorAddrSpec('bob@example.com'), 'bob@example.com');
  assert.equal(authorAddrSpec('  <carol@example.com>  '), 'carol@example.com');
});

test('authorAddrSpec defeats the display-name decoy — takes the address the MUA shows', () => {
  // The classic spoof: a decoy angle-addr hidden in a quoted-string display-name, then the
  // REAL angle-addr the client renders. A naive first-<> match reads a@evil.com; we must read
  // victim@bank.com (the last angle-addr, after quoted-strings are stripped).
  assert.equal(authorAddrSpec('"x <a@evil.com>" <victim@bank.com>'), 'victim@bank.com');
  // Same trick with an RFC 5322 comment holding the decoy.
  assert.equal(authorAddrSpec('(a@evil.com) <victim@bank.com>'), 'victim@bank.com');
  // Escaped quote inside the quoted-string must not end it early.
  assert.equal(authorAddrSpec('"he said \\"hi\\" <a@evil.com>" <real@good.com>'), 'real@good.com');
});

test('authorAddrSpec returns null when there is no address', () => {
  assert.equal(authorAddrSpec('Just A Name'), null);
  assert.equal(authorAddrSpec('"quoted only"'), null);
  assert.equal(authorAddrSpec(''), null);
});

test('domainOfAddrSpec lower-cases and strips a root-anchoring trailing dot', () => {
  assert.equal(domainOfAddrSpec('a@Example.COM'), 'example.com');
  assert.equal(domainOfAddrSpec('a@example.com.'), 'example.com');
  assert.equal(domainOfAddrSpec('no-at-sign'), null);
});

const msg = (headers: string): Buffer => Buffer.from(`${headers}\r\n\r\nbody\r\n`, 'latin1');

test('fromAuthor extracts the single author and counts one', () => {
  const r = fromAuthor(msg('From: Alice <alice@example.com>\r\nTo: b@x.test'));
  assert.equal(r.address, 'alice@example.com');
  assert.equal(r.count, 1);
});

test('fromAuthor counts a second From (the multi-From spoof signal)', () => {
  const r = fromAuthor(msg('From: victim@bank.com\r\nFrom: attacker@evil.com'));
  assert.equal(r.count, 2, 'both From headers are counted so the caller can reject');
});

test('fromAuthor reports zero From headers as count 0 / null', () => {
  const r = fromAuthor(msg('To: b@x.test\r\nSubject: no from'));
  assert.equal(r.address, null);
  assert.equal(r.count, 0);
});

test('fromAuthor reads the From value through the spoof-hardened parse', () => {
  // Proves fromAuthor and authorAddrSpec agree end to end on the decoy.
  const r = fromAuthor(msg('From: "x <a@evil.com>" <victim@bank.com>'));
  assert.equal(r.address, 'victim@bank.com');
  assert.equal(r.count, 1);
});
