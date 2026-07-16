/**
 * The DKIM canonicalization corpus (RFC 6376 §3.4), with negative controls.
 *
 * Its ground truth is stronger than the other corpora's: RFC 6376 §3.4.5 ships
 * WORKED EXAMPLES, so the conformant assertions are pinned to the spec's own
 * output, not merely to our reference implementation. Each requirement also has a
 * defect proving the check detects a real divergence. Cases cite compile-checked
 * CryptoRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleHeaderField, relaxedHeaderField, simpleBody, relaxedBody } from './dkim-canon.ts';
import { cryptoRequirement } from '../register/crypto/index.ts';
import type { CryptoRequirementId } from '../register/crypto/index.ts';

const B = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);
const eq = (got: Buffer, want: string, msg?: string): void => assert.equal(got.toString('latin1'), want, msg);

// RFC 6376 §3.4.5 Example 1 message pieces (bracketed descriptors rendered to bytes).
const FIELD_A = B('A: X\r\n');
const FIELD_B = B('B : Y\t\r\n\tZ  \r\n'); // folded continuation line
const BODY = B(' C \r\nD \t E\r\n\r\n\r\n');

test('R-6376-3.4.1-a: simple header leaves the field byte-for-byte unchanged (defect caught)', () => {
  cites('R-6376-3.4.1-a');
  // §3.4.5 Example 2: simple header output equals the input exactly.
  eq(simpleHeaderField(FIELD_A), 'A: X\r\n', 'simple header is unchanged');
  eq(simpleHeaderField(FIELD_B), 'B : Y\t\r\n\tZ  \r\n', 'folded field is unchanged');
  // Negative control: any whitespace change is a violation.
  assert.notEqual(simpleHeaderField(FIELD_B, { simpleHeaderMutatesWhitespace: true }).toString('latin1'), 'B : Y\t\r\n\tZ  \r\n', 'simpleHeaderMutatesWhitespace must be detectable');
});

test('R-6376-3.4.2-a: relaxed header lowercases the field name, not the value (defect caught)', () => {
  cites('R-6376-3.4.2-a');
  eq(relaxedHeaderField(B('SUBJect: AbC\r\n')), 'subject:AbC\r\n', 'name lowercased, value case kept');
  // Negative control: keeping the name case.
  eq(relaxedHeaderField(B('SUBJect: AbC\r\n'), { relaxedHeaderKeepsCase: true }), 'SUBJect:AbC\r\n', 'relaxedHeaderKeepsCase must be detectable');
});

test('R-6376-3.4.2-b: relaxed header collapses WSP runs to a single SP (RFC vector; defect caught)', () => {
  cites('R-6376-3.4.2-b');
  // §3.4.5 Example 1: field B canonicalizes to "b:Y Z".
  eq(relaxedHeaderField(FIELD_B), 'b:Y Z\r\n', 'the RFC 6376 §3.4.5 relaxed header vector');
  // Negative control: keeping the WSP runs preserves the doubled/ tab whitespace.
  assert.notEqual(relaxedHeaderField(FIELD_B, { relaxedHeaderKeepsWspRuns: true }).toString('latin1'), 'b:Y Z\r\n', 'relaxedHeaderKeepsWspRuns must be detectable');
});

test('R-6376-3.4.2-c: relaxed header deletes trailing WSP of the value (defect caught)', () => {
  cites('R-6376-3.4.2-c');
  eq(relaxedHeaderField(B('X: value   \r\n')), 'x:value\r\n', 'trailing WSP of the value is deleted');
  // Negative control: keeping trailing WSP leaves a space the conformant output lacks
  // (the run is still collapsed to one SP, so this is "x:value \r\n").
  assert.notEqual(relaxedHeaderField(B('X: value   \r\n'), { relaxedHeaderKeepsTrailingWsp: true }).toString('latin1'), 'x:value\r\n', 'relaxedHeaderKeepsTrailingWsp must be detectable');
});

test('R-6376-3.4.3-a: simple body reduces trailing empty lines to one CRLF (RFC vector; defect caught)', () => {
  cites('R-6376-3.4.3-a');
  // §3.4.5 Example 2: simple body keeps content but trims the trailing blank lines.
  eq(simpleBody(BODY), ' C \r\nD \t E\r\n', 'trailing empty lines reduced to a single CRLF');
  eq(simpleBody(Buffer.alloc(0)), '\r\n', 'an empty body canonicalizes to a single CRLF (2 octets)');
  // Negative control: keeping the trailing blank lines.
  assert.notEqual(simpleBody(BODY, { simpleBodyKeepsTrailingBlankLines: true }).toString('latin1'), ' C \r\nD \t E\r\n', 'simpleBodyKeepsTrailingBlankLines must be detectable');
});

test('R-6376-3.4.4-a: relaxed body ignores trailing WSP on each line (RFC vector; defect caught)', () => {
  cites('R-6376-3.4.4-a');
  // §3.4.5 Example 1: relaxed body is " C\r\nD E\r\n".
  eq(relaxedBody(BODY), ' C\r\nD E\r\n', 'the RFC 6376 §3.4.5 relaxed body vector');
  // Negative control: keeping each line's trailing WSP leaves the space after "C".
  assert.notEqual(relaxedBody(BODY, { relaxedBodyKeepsLineTrailingWsp: true }).toString('latin1'), ' C\r\nD E\r\n', 'relaxedBodyKeepsLineTrailingWsp must be detectable');
});
