/**
 * Submission fix-up (RFC 6409 §8.1/§8.2): missing Date / Message-ID are added at
 * submission; a message that already has both passes through byte-identical.
 * The negative direction here is the pass-through: the fix-up must NOT touch a
 * complete message (a relay altering content it didn't need to is the defect).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSubmissionHeaders, formatDate } from './submission-fixup.ts';
import { parseMessage, hasHeader, MAX_HEADER_SECTION_BYTES } from '../message/parse.ts';

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
  const out = ensureSubmissionHeaders(data, 'mail.example.test', '', CLOCK)!;
  const expectHead =
    'Message-ID: <1784230200000.deadbeefcafe@mail.example.test>\r\n' + 'Date: Thu, 16 Jul 2026 19:30:00 +0000\r\n';
  assert.equal(out.subarray(0, expectHead.length).toString('latin1'), expectHead);
  assert.deepEqual(out.subarray(expectHead.length), data, 'the original message follows, byte-exact');
  const msg = parseMessage(out);
  assert.ok(hasHeader(msg, 'Message-ID') && hasHeader(msg, 'Date'));
});

test('only the missing header is added when the other exists', () => {
  const hasDate = Buffer.from('Date: Thu, 16 Jul 2026 18:00:00 +0000\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(hasDate, 'mail.example.test', '', CLOCK)!;
  const s = out.toString('latin1');
  assert.ok(s.startsWith('Message-ID: <'), 'Message-ID prepended');
  assert.equal(s.match(/^Date:/gm)!.length, 1, 'the existing Date is not duplicated');
});

test('header names match case-insensitively (no duplicate for MESSAGE-ID:)', () => {
  const data = Buffer.from('MESSAGE-ID: <shouty@example.net>\r\nDATE: Thu, 16 Jul 2026 18:00:00 +0000\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', '', CLOCK)!;
  assert.equal(out, data, 'case-variant headers are recognised as present');
});

test('a missing From is added from the envelope sender (RFC 5322 requires it; DKIM must cover it)', () => {
  const data = Buffer.from('Subject: no from\r\n\r\nminimal client sent no From\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', 'alice@sender.test', CLOCK)!;
  const msg = parseMessage(out);
  assert.ok(hasHeader(msg, 'From'), 'a From header is now present');
  assert.match(out.toString('latin1'), /From: <alice@sender\.test>/, 'it uses the envelope sender address');
});

test('an existing From is never overwritten', () => {
  const data = Buffer.from('From: real@author.test\r\nDate: Thu, 16 Jul 2026 18:00:00 +0000\r\nMessage-ID: <x@y>\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const out = ensureSubmissionHeaders(data, 'mail.example.test', 'envelope@sender.test', CLOCK);
  assert.equal(out, data, 'a message with From/Date/Message-ID is byte-identical (From not touched)');
});

test('a message the added headers would push over the cap is refused, not returned', () => {
  // The check used to run on the INPUT and the function returns something LARGER. So a header
  // section sitting just under MAX_HEADER_SECTION_BYTES could be pushed over it by the very headers
  // added here: the caller re-parses what comes back to decide which From it is authorising, that
  // parse silently drops the fields past the cap, and the send-as gate approved a message carrying
  // one From while the bytes it approved carried two — the owned address on top, an unowned one
  // buried below. Prepending Date is a fixed 39 bytes, so the window is exact rather than lucky.
  const owned = 'From: alice@one.example\r\n';
  const unowned = 'From: bob@two.example\r\n';
  const id = 'Message-ID: <x@one.example>\r\n'; // supplied, so only Date is prepended
  const fixed = 'Date: Thu, 01 Jan 1970 00:00:00 +0000\r\n'.length;

  for (const slack of [1, 20, fixed - 1]) {
    const padLen = MAX_HEADER_SECTION_BYTES - owned.length - id.length - unowned.length - slack;
    const pad = `X-Pad: ${'a'.repeat(padLen - 'X-Pad: \r\n'.length)}\r\n`;
    const data = Buffer.from(`${owned}${id}${pad}${unowned}\r\nbody\r\n`, 'latin1');

    assert.equal(parseMessage(data).headersTruncated, false, `slack ${slack}: the input itself is not truncated`);
    const out = ensureSubmissionHeaders(data, 'one.example', 'alice@one.example', {
      now: () => new Date(0),
      unique: () => 'abc',
    });
    assert.equal(out, null, `slack ${slack}: a result whose header section truncates must be refused`);
  }
});
