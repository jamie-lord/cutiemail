/**
 * The RFC 2047 encoded-word conformance corpus, with negative controls.
 *
 * Each case proves the decoder handles a valid encoded-word AND enforces a
 * structural/placement rule — with the matching defect (which relaxes that rule)
 * DETECTED. The theme is that a malformed or misplaced encoded-word must never be
 * silently decoded, because that is how a hidden payload gets in. Cases cite
 * compile-checked MessageRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEncodedWords, hasEncodedWordAnomaly } from './encoded-word.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const w = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);
const decoded = (s: string, o = {}): string => decodeEncodedWords(w(s), o).text.toString('latin1');

test('sanity: valid B and Q encoded-words decode (RFC 2047 examples)', () => {
  assert.equal(decoded('=?US-ASCII?Q?Keith_Moore?='), 'Keith Moore');
  assert.equal(decoded('=?ISO-8859-1?B?SGVsbG8=?='), 'Hello');
  assert.equal(decoded('plain =?utf-8?Q?x?= text'), 'plain x text', 'whitespace around ordinary text is kept');
});

test('R-2047-2-a: a token with internal whitespace is not decoded (acceptInternalWhitespace caught)', () => {
  cites('R-2047-2-a');
  const broken = '=?utf-8?B?aGk =?=';
  const r = decodeEncodedWords(w(broken));
  assert.ok(hasEncodedWordAnomaly(r, 'internal-whitespace'), 'internal whitespace is flagged');
  assert.equal(r.text.toString('latin1'), broken, 'the malformed token is left literal, not decoded');
  // Negative control: accepting internal whitespace decodes the broken token.
  const defect = decodeEncodedWords(w(broken), { acceptInternalWhitespace: true });
  assert.notEqual(defect.text.toString('latin1'), broken, 'acceptInternalWhitespace must be detectable');
});

test('R-2047-2-b: an encoded-word longer than 75 chars is flagged (acceptOverlongWord caught)', () => {
  cites('R-2047-2-b');
  // A Q-word whose total length exceeds 75.
  const longWord = `=?utf-8?Q?${'x'.repeat(80)}?=`;
  assert.ok(longWord.length > 75);
  assert.ok(hasEncodedWordAnomaly(decodeEncodedWords(w(longWord)), 'overlong-word'), 'an over-75 token is flagged');
  assert.ok(!hasEncodedWordAnomaly(decodeEncodedWords(w('=?utf-8?Q?short?=')), 'overlong-word'), 'a short token is fine');
  assert.ok(!hasEncodedWordAnomaly(decodeEncodedWords(w(longWord), { acceptOverlongWord: true }), 'overlong-word'), 'acceptOverlongWord must be detectable');
});

test('R-2047-5-a: an encoded-word in addr-spec context is not decoded (decodeInAddrSpec caught)', () => {
  cites('R-2047-5-a');
  const inAddr = '=?utf-8?Q?user?=@example.com';
  const r = decodeEncodedWords(w(inAddr), { addrSpecContext: true });
  assert.ok(hasEncodedWordAnomaly(r, 'encoded-word-in-addr-spec'), 'an encoded-word in an address is flagged');
  assert.equal(r.text.toString('latin1'), inAddr, 'it is left literal, never decoded into the address');
  // Negative control: decoding it in address context.
  const defect = decodeEncodedWords(w(inAddr), { addrSpecContext: true, decodeInAddrSpec: true });
  assert.notEqual(defect.text.toString('latin1'), inAddr, 'decodeInAddrSpec must be detectable');
});

test('R-2047-6.2-a: whitespace between adjacent encoded-words is ignored (keepInterWordWhitespace caught)', () => {
  cites('R-2047-6.2-a');
  // Two adjacent encoded-words separated by a space: the space is dropped on join.
  assert.equal(decoded('=?utf-8?Q?a?= =?utf-8?Q?b?='), 'ab', 'the inter-word whitespace is ignored');
  // Negative control: keeping it leaves a spurious space.
  assert.equal(decoded('=?utf-8?Q?a?= =?utf-8?Q?b?=', { keepInterWordWhitespace: true }), 'a b', 'keepInterWordWhitespace must be detectable');
});
