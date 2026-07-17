/**
 * BODYSTRUCTURE / BODY construction (RFC 9051 §7.5.2), built on the tested MIME split.
 * Covers the shapes a client actually renders from: a single text part, a multipart
 * with an attachment (the name/filename a client shows), a nested multipart, and the
 * default when Content-Type is absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyResponse, bodyStructureResponse } from './body-structure.ts';

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
