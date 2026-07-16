/**
 * The Received trace header (RFC 5321 §4.4): a well-formed line with the client
 * identity, our hostname, the right "with" protocol for the connection's
 * TLS/auth state (RFC 3848), and — because it's prepended — it must sit above the
 * message's own headers without disturbing them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receivedHeader, prependReceived, protocolFor, countReceived } from './received.ts';

const AT = new Date(Date.UTC(2026, 6, 16, 20, 15, 0));

test('protocolFor picks ESMTP / ESMTPS / ESMTPSA by TLS and auth', () => {
  assert.equal(protocolFor(false, false), 'ESMTP');
  assert.equal(protocolFor(true, false), 'ESMTPS');
  assert.equal(protocolFor(true, true), 'ESMTPSA');
});

test('the header carries the client, our host, protocol, id, for-clause and date', () => {
  const h = receivedHeader({
    helo: 'sender.example.net',
    remoteAddress: '198.51.100.7',
    by: 'mail.example.test',
    protocol: 'ESMTP',
    id: 'abc123',
    forRecipient: 'you@mail.example.test',
    date: AT,
  });
  assert.equal(
    h,
    'Received: from sender.example.net ([198.51.100.7]) by mail.example.test with ESMTP id abc123 for <you@mail.example.test>; Thu, 16 Jul 2026 20:15:00 +0000',
  );
});

test('the for-clause is omitted when no single recipient is given', () => {
  const h = receivedHeader({ helo: 'c', remoteAddress: '', by: 'us', protocol: 'ESMTPSA', id: 'x', date: AT });
  assert.ok(!h.includes(' for <'), 'no for-clause');
  assert.ok(h.includes('from c by us with ESMTPSA'), 'no IP clause when the address is unknown');
});

test('countReceived counts field starts only, skipping folded continuation lines', () => {
  const msg = Buffer.from(
    'Received: from a\r\n' +
      'Received: from b\r\n' +
      '\tby c with ESMTP\r\n' + // folded continuation of the 2nd Received — not a new one
      'Subject: x\r\n\r\n' +
      'Received: not-a-header-its-body\r\n', // in the body — not counted
    'latin1',
  );
  assert.equal(countReceived(msg), 2);
});

test('countReceived is zero for a message with no Received headers', () => {
  assert.equal(countReceived(Buffer.from('Subject: x\r\n\r\nbody\r\n', 'latin1')), 0);
});

test('prependReceived puts the trace line above the existing headers, byte-exact below', () => {
  const msg = Buffer.from('Subject: hi\r\nFrom: a@b\r\n\r\nbody\r\n', 'latin1');
  const out = prependReceived(msg, { helo: 'c', remoteAddress: '10.0.0.1', by: 'us', protocol: 'ESMTP', id: 'i', date: AT });
  const s = out.toString('latin1');
  assert.ok(s.startsWith('Received: from c '), 'trace line first');
  assert.ok(out.subarray(out.indexOf(Buffer.from('Subject:'))).equals(msg), 'original message untouched below the trace line');
});
