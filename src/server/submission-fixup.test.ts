/**
 * Submission fix-up (RFC 6409 §8.1/§8.2): missing Date / Message-ID are added at
 * submission; a message that already has both passes through byte-identical.
 * The negative direction here is the pass-through: the fix-up must NOT touch a
 * complete message (a relay altering content it didn't need to is the defect).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSubmissionHeaders, formatDate } from './submission-fixup.ts';
import { parseMessage, hasHeader } from '../message/parse.ts';

const CLOCK = {
  now: () => new Date(Date.UTC(2026, 6, 16, 19, 30, 0)),
  unique: () => 'deadbeefcafe',
};

test('formatDate renders RFC 5322 date-time in UTC', () => {
  assert.equal(formatDate(CLOCK.now()), 'Thu, 16 Jul 2026 19:30:00 +0000');
});

test('a message with both headers passes through byte-identical (same Buffer)', () => {
  const data = Buffer.from(
    'Message-ID: <existing@example.net>\r\nDate: Thu, 16 Jul 2026 18:00:00 +0000\r\nSubject: x\r\n\r\nbody\r\n',
    'latin1',
  );
  const out = ensureSubmissionHeaders(data, 'mail.example.test', '', CLOCK);
  assert.equal(out, data, 'untouched message returns the SAME Buffer, not a copy');
});

test('missing Message-ID and Date are both prepended, and the result parses with them present', () => {
  const data = Buffer.from('Subject: bare\r\nFrom: a@example.net\r\n\r\nminimal client\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', '', CLOCK);
  const expectHead =
    'Message-ID: <1784230200000.deadbeefcafe@mail.example.test>\r\n' + 'Date: Thu, 16 Jul 2026 19:30:00 +0000\r\n';
  assert.equal(out.subarray(0, expectHead.length).toString('latin1'), expectHead);
  assert.deepEqual(out.subarray(expectHead.length), data, 'the original message follows, byte-exact');
  const msg = parseMessage(out);
  assert.ok(hasHeader(msg, 'Message-ID') && hasHeader(msg, 'Date'));
});

test('only the missing header is added when the other exists', () => {
  const hasDate = Buffer.from('Date: Thu, 16 Jul 2026 18:00:00 +0000\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(hasDate, 'mail.example.test', '', CLOCK);
  const s = out.toString('latin1');
  assert.ok(s.startsWith('Message-ID: <'), 'Message-ID prepended');
  assert.equal(s.match(/^Date:/gm)!.length, 1, 'the existing Date is not duplicated');
});

test('header names match case-insensitively (no duplicate for MESSAGE-ID:)', () => {
  const data = Buffer.from('MESSAGE-ID: <shouty@example.net>\r\nDATE: Thu, 16 Jul 2026 18:00:00 +0000\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', '', CLOCK);
  assert.equal(out, data, 'case-variant headers are recognised as present');
});

test('a missing From is added from the envelope sender (RFC 5322 requires it; DKIM must cover it)', () => {
  const data = Buffer.from('Subject: no from\r\n\r\nminimal client sent no From\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', 'alice@sender.test', CLOCK);
  const msg = parseMessage(out);
  assert.ok(hasHeader(msg, 'From'), 'a From header is now present');
  assert.match(out.toString('latin1'), /From: <alice@sender\.test>/, 'it uses the envelope sender address');
});

test('an existing From is never overwritten', () => {
  const data = Buffer.from('From: real@author.test\r\nDate: Thu, 16 Jul 2026 18:00:00 +0000\r\nMessage-ID: <x@y>\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', 'envelope@sender.test', CLOCK);
  assert.equal(out, data, 'a message with From/Date/Message-ID is byte-identical (From not touched)');
});
