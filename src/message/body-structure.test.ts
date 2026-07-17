/**
 * BODYSTRUCTURE / BODY construction (RFC 9051 §7.5.2), built on the tested MIME split.
 * Covers the shapes a client actually renders from: a single text part, a multipart
 * with an attachment (the name/filename a client shows), a nested multipart, and the
 * default when Content-Type is absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyResponse, bodyStructureResponse, resolvePart } from './body-structure.ts';

const msg = (s: string): Buffer => Buffer.from(s.replace(/\n/g, '\r\n'), 'latin1');

test('a single text/plain part reports type, params, encoding, size and line count', () => {
  const b = bodyStructureResponse(msg('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 7bit\n\nHello\nWorld\n'));
  assert.match(b, /^\("TEXT" "PLAIN" \("charset" "utf-8"\) NIL NIL "7BIT" \d+ 2 /, 'text part with 2 lines');
});

test('an absent Content-Type defaults to text/plain (RFC 2045 §5.2)', () => {
  const b = bodyStructureResponse(msg('Subject: bare\n\njust text\n'));
  assert.match(b, /^\("TEXT" "PLAIN"/, 'the default media type is text/plain');
});

test('a multipart with an attachment exposes the filename and disposition', () => {
  const raw = msg(
    'Content-Type: multipart/mixed; boundary="B"\n\n' +
      '--B\nContent-Type: text/plain\n\nthe message\n' +
      '--B\nContent-Type: application/pdf; name="report.pdf"\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="report.pdf"\n\nJVBERi0K\n' +
      '--B--\n',
  );
  const bs = bodyStructureResponse(raw);
  // Two children then the subtype, then the multipart params.
  assert.match(bs, /"MIXED" \("boundary" "B"\)/, 'the multipart subtype and boundary are reported');
  assert.match(bs, /"APPLICATION" "PDF" \("name" "report\.pdf"\)/, 'the attachment media type and name');
  assert.match(bs, /"BASE64" \d+ NIL \("attachment" \("filename" "report\.pdf"\)\)/, 'the transfer encoding and disposition with filename');
  // The basic BODY form omits the disposition/extension fields.
  const body = bodyResponse(raw);
  assert.match(body, /\("TEXT" "PLAIN" NIL NIL NIL "7BIT" \d+ \d+\)\("APPLICATION" "PDF"/, 'BODY lists both parts without extension fields');
  assert.doesNotMatch(body, /attachment/, 'BODY (non-extensible) omits the disposition');
});

test('a nested multipart/alternative inside multipart/mixed recurses', () => {
  const raw = msg(
    'Content-Type: multipart/mixed; boundary="OUT"\n\n' +
      '--OUT\nContent-Type: multipart/alternative; boundary="IN"\n\n' +
      '--IN\nContent-Type: text/plain\n\nplain\n' +
      '--IN\nContent-Type: text/html\n\n<p>html</p>\n' +
      '--IN--\n' +
      '--OUT\nContent-Type: image/png; name="pic.png"\nContent-Transfer-Encoding: base64\n\niVBOR\n' +
      '--OUT--\n',
  );
  const bs = bodyStructureResponse(raw);
  assert.match(bs, /"ALTERNATIVE"/, 'the inner multipart/alternative is present');
  assert.match(bs, /"TEXT" "PLAIN".*"TEXT" "HTML"/s, 'both alternatives are nested inside it');
  assert.match(bs, /"IMAGE" "PNG" \("name" "pic\.png"\)/, 'the sibling image part is present');
  assert.match(bs, /"MIXED"/, 'the outer container is multipart/mixed');
});

test('a message/rfc822 attachment carries the forwarded message envelope and structure', () => {
  const inner = 'From: orig@sender.test\r\nTo: me@x.test\r\nSubject: forwarded subject\r\nDate: Wed, 01 Jan 2025 10:00:00 +0000\r\n\r\nforwarded body\r\n';
  const raw = Buffer.from(
    'Content-Type: multipart/mixed; boundary=B\r\n\r\n' +
      '--B\r\nContent-Type: text/plain\r\n\r\nsee forwarded\r\n' +
      '--B\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\n\r\n' +
      inner +
      '--B--\r\n',
    'latin1',
  );
  const bs = bodyStructureResponse(raw);
  assert.match(bs, /"MESSAGE" "RFC822"/, 'the forwarded part is message/rfc822');
  // The nested ENVELOPE exposes the forwarded subject/sender without a download.
  assert.match(bs, /"forwarded subject"/, "the forwarded message's subject is in the nested envelope");
  assert.match(bs, /"orig" "sender\.test"/, 'the forwarded sender is present');
  // The nested body structure follows the envelope.
  assert.match(bs, /"MESSAGE" "RFC822".*"forwarded subject".*"TEXT" "PLAIN"/s, 'the nested body structure follows the envelope');
});

test('a multipart whose boundary matches no parts yields a valid leaf, not an empty multipart', () => {
  // RFC 9051 body-type-mpart requires >= 1 nested body; "("MIXED" ...)" (no leading
  // nested body) desyncs a strict client's FETCH parse. A boundary that matches nothing
  // must degrade to a single leaf.
  const bs = bodyStructureResponse(msg('Content-Type: multipart/mixed; boundary=NOPE\n\njust text, no boundary here\n'));
  assert.ok(bs.startsWith('("TEXT" "PLAIN"'), 'the empty multipart is reported as a text leaf, a valid structure');
  assert.doesNotMatch(bs, /^\(\s*"MIXED"/, 'never an empty multipart with a string where a nested body is required');
});

test('a NUL or control octet in a header/filename is not emitted raw in a quoted string', () => {
  // A raw NUL is illegal in an IMAP quoted string and desyncs a strict FETCH parser.
  const raw = msg('Content-Type: application/octet-stream; name="ev\x00il.exe"\nContent-Transfer-Encoding: base64\n\nAAAA\n');
  const bs = bodyStructureResponse(raw);
  assert.ok(!bs.includes('\x00'), 'no raw NUL survives into the BODYSTRUCTURE');
  assert.match(bs, /"ev il\.exe"/, 'the control octet was collapsed to a space');
});

test('a pathologically deep multipart is bounded, not a stack overflow (DoS guard)', () => {
  let m = 'Content-Type: text/plain\r\n\r\nleaf\r\n';
  for (let i = 0; i < 5000; i++) {
    const b = `B${i}`;
    m = `Content-Type: multipart/mixed; boundary=${b}\r\n\r\n--${b}\r\n${m}--${b}--\r\n`;
  }
  // Must return a value (bounded at the depth cap), never throw a RangeError.
  const bs = bodyStructureResponse(Buffer.from(m, 'latin1'));
  assert.ok(bs.length > 0 && bs.startsWith('('), 'a deeply nested message yields a bounded structure, not a crash');
});

test('BODYSTRUCTURE and resolvePart never crash on fuzzed / malformed MIME', () => {
  // Deterministic mulberry32 PRNG (no Math.random) so a failure reproduces.
  let a = 0xb0d5 >>> 0;
  const rng = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const frags = [
    'Content-Type: multipart/mixed; boundary=B\r\n', 'Content-Type: text/plain\r\n', 'Content-Type: ///\r\n',
    'Content-Type: message/rfc822\r\n', 'Content-Transfer-Encoding: base64\r\n', 'Content-Disposition: attachment; filename=\r\n',
    '--B\r\n', '--B--\r\n', '--\r\n', '\r\n', 'body bytes\r\n', 'boundary=', 'name="x"', String.fromCharCode(0), 'x'.repeat(50),
  ];
  for (let i = 0; i < 800; i++) {
    let raw = '';
    const n = 1 + Math.floor(rng() * 20);
    for (let j = 0; j < n; j++) raw += frags[Math.floor(rng() * frags.length)]!;
    const buf = Buffer.from(raw, 'latin1');
    // None of these must throw; the structure must serialise to a parenthesised value.
    const bs = bodyStructureResponse(buf);
    assert.ok(bs.startsWith('('), `structure must be a parenthesised value for input #${i}`);
    bodyResponse(buf);
    resolvePart(buf, [1]);
    resolvePart(buf, [1, 2, 1]);
  }
});
