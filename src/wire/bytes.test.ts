/**
 * Byte-DSL invariants.
 *
 * The DSL is where the corpus's malformed input is authored. If it ever
 * normalises, or silently truncates a codepoint, the smuggling tests become
 * tests that pass while sending well-formed traffic — the worst failure this
 * project has available, because everything downstream would look green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crlf, lf, cr, bare, utf8, b, cat, rep, dotStuff, dump, show, latin1,
  NonLatin1Error, CRLF, EOD,
} from './bytes.ts';

test('crlf terminates with exactly CR LF', () => {
  assert.deepEqual(crlf`EHLO x`, Buffer.from([0x45, 0x48, 0x4c, 0x4f, 0x20, 0x78, 0x0d, 0x0a]));
});

test('lf terminates with a bare LF and no CR', () => {
  const out = lf`EHLO x`;
  assert.equal(out.at(-1), 0x0a);
  assert.notEqual(out.at(-2), 0x0d, 'a CR here would silently defang the smuggling corpus');
  assert.deepEqual(out, Buffer.from([0x45, 0x48, 0x4c, 0x4f, 0x20, 0x78, 0x0a]));
});

test('cr terminates with a bare CR and no LF', () => {
  const out = cr`EHLO x`;
  assert.equal(out.at(-1), 0x0d);
  assert.equal(out.length, 7);
});

test('bare appends nothing', () => {
  assert.deepEqual(bare`EHLO x`, Buffer.from('EHLO x', 'latin1'));
});

test('there is no way to write a line without naming its terminator', () => {
  // Not an assertion about code so much as about the API's shape: every
  // constructor above is named for its terminator. This test documents the
  // invariant so a future "convenience" default fails review.
  const constructors = [crlf, lf, cr, bare, utf8];
  assert.equal(constructors.length, 5);
  assert.deepEqual(
    constructors.map((f) => f.name).sort(),
    ['bare', 'cr', 'crlf', 'lf', 'utf8'],
  );
});

test('latin1 maps U+0000-U+00FF to single octets exactly', () => {
  assert.deepEqual(latin1('\x00\x7f\x80\xff'), Buffer.from([0x00, 0x7f, 0x80, 0xff]));
  assert.deepEqual(latin1('café'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
});

test('a codepoint above U+00FF throws rather than being truncated', () => {
  // Node's latin1 encoder masks to the low byte: '日' (U+65E5) would become
  // 0xE5. A corrupted test that still passes is the worst outcome available.
  assert.throws(() => latin1('日本'), NonLatin1Error);
  assert.throws(() => crlf`MAIL FROM:<日@x>`, NonLatin1Error);
  assert.throws(() => latin1('Ā'), NonLatin1Error);
});

test('the throw names the offending codepoint and points at utf8', () => {
  try {
    latin1('a日');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof NonLatin1Error);
    assert.match(e.message, /U\+65E5/);
    assert.match(e.message, /index 1/);
    assert.match(e.message, /utf8/);
  }
});

test('utf8 encodes multi-byte and terminates with CRLF', () => {
  const out = utf8`RCPT TO:<日@x>`;
  assert.ok(out.includes(Buffer.from('日', 'utf8')));
  assert.deepEqual(out.subarray(-2), CRLF);
});

test('interpolation accepts buffers, octets and strings', () => {
  assert.deepEqual(crlf`A${b(0x00)}B`, Buffer.from([0x41, 0x00, 0x42, 0x0d, 0x0a]));
  assert.deepEqual(crlf`A${0xff}B`, Buffer.from([0x41, 0xff, 0x42, 0x0d, 0x0a]));
  assert.deepEqual(bare`x${Buffer.from([0x01])}y`, Buffer.from([0x78, 0x01, 0x79]));
});

test('an interpolated number must be an octet', () => {
  assert.throws(() => crlf`${256}`, RangeError);
  assert.throws(() => crlf`${-1}`, RangeError);
  assert.throws(() => crlf`${1.5}`, RangeError);
});

test('b builds exact octet sequences including CR CR LF', () => {
  assert.deepEqual(b(0x0d, 0x0d, 0x0a), Buffer.from([0x0d, 0x0d, 0x0a]));
  assert.throws(() => b(0x100), RangeError);
});

test('EOD is exactly CRLF.CRLF', () => {
  assert.deepEqual(EOD, Buffer.from([0x0d, 0x0a, 0x2e, 0x0d, 0x0a]));
});

test('rep builds boundary-sized payloads', () => {
  assert.equal(rep(0x78, 1000).length, 1000);
  assert.ok(rep(0x78, 1000).every((o) => o === 0x78));
});

test('dotStuff doubles a leading dot at the start of a line', () => {
  assert.deepEqual(dotStuff(Buffer.from('.hidden\r\n', 'latin1')), Buffer.from('..hidden\r\n', 'latin1'));
  assert.deepEqual(
    dotStuff(Buffer.from('a\r\n.b\r\nc\r\n', 'latin1')),
    Buffer.from('a\r\n..b\r\nc\r\n', 'latin1'),
  );
});

test('dotStuff leaves a dot mid-line alone', () => {
  assert.deepEqual(dotStuff(Buffer.from('a.b\r\n', 'latin1')), Buffer.from('a.b\r\n', 'latin1'));
});

test('dotStuff handles a lone dot line and consecutive dot lines', () => {
  assert.deepEqual(dotStuff(Buffer.from('.\r\n', 'latin1')), Buffer.from('..\r\n', 'latin1'));
  assert.deepEqual(
    dotStuff(Buffer.from('.\r\n.\r\n', 'latin1')),
    Buffer.from('..\r\n..\r\n', 'latin1'),
  );
});

test('dotStuff only treats CRLF as a line break, not a bare LF', () => {
  // A body with bare LFs already violates §2.3.8; "correct" stuffing of it is
  // undefined, so we deliberately do not guess. Such cases are authored by hand.
  assert.deepEqual(
    dotStuff(Buffer.from('a\n.b\r\n', 'latin1')),
    Buffer.from('a\n.b\r\n', 'latin1'),
    'a dot after a bare LF is not treated as line-initial',
  );
});

test('dotStuff is not applied by any constructor automatically', () => {
  // Half the DATA corpus sends unstuffed or wrongly-stuffed content on purpose.
  assert.deepEqual(crlf`.hidden`, Buffer.from('.hidden\r\n', 'latin1'));
});

test('dump renders CR and LF visibly', () => {
  const out = dump(Buffer.from([0x41, 0x0d, 0x0a]));
  assert.match(out, /41 0d 0a/);
  assert.match(out, /A␍␊/);
});

test('dump handles an empty buffer and non-printables', () => {
  assert.match(dump(Buffer.alloc(0)), /<empty>/);
  assert.match(dump(Buffer.from([0xff, 0x00])), /ff 00/);
  assert.match(dump(Buffer.from([0xff, 0x00])), /··/);
});

test('show renders a one-line escape suitable for assertion messages', () => {
  assert.equal(show(Buffer.from([0x45, 0x0d, 0x0a])), 'E\\r\\n');
  assert.equal(show(Buffer.from([0xff])), '\\xff');
  assert.equal(show(Buffer.from([0x09])), '\\t');
});

test('cat concatenates in order', () => {
  assert.deepEqual(cat(crlf`A`, lf`B`), Buffer.from([0x41, 0x0d, 0x0a, 0x42, 0x0a]));
});
