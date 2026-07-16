/**
 * The MIME Content-* conformance corpus (RFC 2045), with negative controls.
 *
 * Each case proves the analyzer is CONFORMANT with no defects and that the
 * matching defect is DETECTED — the same discipline as the receiver and message
 * corpora. Cases cite compile-checked MessageRequirementIds.
 *
 * The theme is MIME-confusion: every check is a place two agents could otherwise
 * read the same header two different ways.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMime, hasMimeAnomaly } from './mime.ts';
import type { Header } from './model.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const hdr = (name: string, value: string): Header => ({
  name: Buffer.from(name, 'latin1'),
  value: Buffer.from(value, 'latin1'),
});
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

const MIME = hdr('MIME-Version', '1.0');

test('sanity: a well-formed MIME entity analyzes cleanly', () => {
  const info = analyzeMime([MIME, hdr('Content-Type', 'text/html; charset=utf-8'), hdr('Content-Transfer-Encoding', 'base64')]);
  assert.equal(info.contentType.type, 'text');
  assert.equal(info.contentType.subtype, 'html');
  assert.equal(info.cte, 'base64');
  assert.ok(info.cteRecognized && !info.octetStreamTreatment);
  assert.deepEqual(info.anomalies, []);
});

test('R-2045-4-a: a missing MIME-Version is flagged (and the defect is caught)', () => {
  cites('R-2045-4-a');
  const noVersion = [hdr('Content-Type', 'text/plain')];
  assert.ok(hasMimeAnomaly(analyzeMime(noVersion), 'missing-mime-version'), 'a top-level message without MIME-Version is flagged');
  assert.ok(!hasMimeAnomaly(analyzeMime([MIME, hdr('Content-Type', 'text/plain')]), 'missing-mime-version'), 'present MIME-Version is not flagged');
  // A non-1.0 version "cannot be assumed to conform".
  assert.ok(hasMimeAnomaly(analyzeMime([hdr('MIME-Version', '2.0'), hdr('Content-Type', 'text/plain')]), 'mime-version-not-1.0'));
  // Negative control.
  assert.ok(!hasMimeAnomaly(analyzeMime(noVersion, { dontFlagMissingMimeVersion: true }), 'missing-mime-version'), 'dontFlagMissingMimeVersion must be detectable');
});

test('R-2045-5-a: type/subtype matching is case-insensitive (and caseSensitiveType is caught)', () => {
  cites('R-2045-5-a');
  const info = analyzeMime([MIME, hdr('Content-Type', 'Text/HTML; charset=UTF-8')]);
  assert.equal(info.contentType.type, 'text', 'type is lowercased for exact matching');
  assert.equal(info.contentType.subtype, 'html', 'subtype is lowercased');
  // Negative control: preserving case breaks the match.
  const defect = analyzeMime([MIME, hdr('Content-Type', 'Text/HTML')], { caseSensitiveType: true });
  assert.notEqual(defect.contentType.type, 'text', 'caseSensitiveType must be detectable');
});

test('opinionated cut: a duplicate Content-Type is flagged as ambiguous (defect caught)', () => {
  cites('R-2045-5-a');
  const dup = [MIME, hdr('Content-Type', 'text/plain'), hdr('Content-Type', 'text/html')];
  assert.ok(hasMimeAnomaly(analyzeMime(dup), 'duplicate-content-type'), 'two Content-Type headers is a MIME-confusion vector, flagged');
  assert.ok(!hasMimeAnomaly(analyzeMime(dup, { acceptDuplicateContentType: true }), 'duplicate-content-type'), 'acceptDuplicateContentType must be detectable');
});

test('R-2045-5-b: an unrecognized parameter is ignored, not fatal (and failOnUnknownParam is caught)', () => {
  cites('R-2045-5-b');
  // A non-default base type (text/html), so if the defect drops to the text/plain
  // default the loss is visible.
  const withUnknown = [MIME, hdr('Content-Type', 'text/html; charset=us-ascii; bogusparam=whatever')];
  const info = analyzeMime(withUnknown);
  assert.equal(info.contentType.type, 'text', 'the media type survives an unknown parameter');
  assert.equal(info.contentType.subtype, 'html');
  assert.ok(info.contentType.ignoredParams.includes('bogusparam'), 'the unknown parameter is recorded as ignored');
  assert.ok(info.contentType.valid, 'the type stays valid');
  // Negative control: letting the unknown param invalidate the type loses it
  // (the analyzer falls back to the text/plain default, so html is gone).
  const defect = analyzeMime(withUnknown, { failOnUnknownParam: true });
  assert.notEqual(defect.contentType.subtype, 'html', 'failOnUnknownParam must be detectable');
});

test('R-2045-5.2-a: a missing Content-Type defaults to text/plain (and noDefaultContentType is caught)', () => {
  cites('R-2045-5.2-a');
  const info = analyzeMime([MIME]);
  assert.equal(info.contentType.type, 'text', 'no Content-Type defaults to text/plain');
  assert.equal(info.contentType.subtype, 'plain');
  assert.equal(info.contentType.params.get('charset'), 'us-ascii', 'the default charset is us-ascii');
  // Negative control: not defaulting leaves the entity with no concrete type.
  const defect = analyzeMime([MIME], { noDefaultContentType: true });
  assert.ok(defect.contentType.type !== 'text' || !defect.contentType.valid, 'noDefaultContentType must be detectable');
});

test('R-2045-6-a: an unrecognized CTE forces octet-stream treatment (and acceptUnknownCte is caught)', () => {
  cites('R-2045-6-a');
  const weird = [MIME, hdr('Content-Type', 'text/plain'), hdr('Content-Transfer-Encoding', 'x-uuencode-bogus')];
  const info = analyzeMime(weird);
  assert.ok(!info.cteRecognized, 'an unknown mechanism is not recognized');
  assert.ok(info.octetStreamTreatment, 'the body must be treated as opaque octets, not decoded');
  assert.ok(hasMimeAnomaly(info, 'unknown-cte'));
  // Known mechanisms are case-insensitive (§6.1) and do NOT force octet-stream.
  const base64Caps = analyzeMime([MIME, hdr('Content-Transfer-Encoding', 'BASE64')]);
  assert.ok(base64Caps.cteRecognized && !base64Caps.octetStreamTreatment, 'BASE64 == base64');
  // Negative control: pretending to understand the unknown encoding.
  const defect = analyzeMime(weird, { acceptUnknownCte: true });
  assert.ok(defect.cteRecognized && !defect.octetStreamTreatment, 'acceptUnknownCte must be detectable');
});
