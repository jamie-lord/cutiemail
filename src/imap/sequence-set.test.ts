/**
 * The IMAP sequence-set corpus (RFC 9051 §9 + §2.3.1.1), with negative controls.
 * Proves "*" resolves to the largest number and ranges are order-independent, with
 * each rule's defect DETECTED. Cites compile-checked ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSequenceSet } from './sequence-set.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('sanity: numbers, ranges, and commas resolve', () => {
  assert.deepEqual(parseSequenceSet('1,3,5', 10), [1, 3, 5]);
  assert.deepEqual(parseSequenceSet('1:3', 10), [1, 2, 3]);
  assert.deepEqual(parseSequenceSet('1:3,3,5', 10), [1, 2, 3, 5], 'overlaps de-duplicate');
});

test('R-9051-9-a: "*" resolves to the largest number in use (starIsLiteralOne caught)', () => {
  cites('R-9051-9-a');
  assert.deepEqual(parseSequenceSet('*', 5), [5], '"*" is the largest, here 5');
  assert.deepEqual(parseSequenceSet('3:*', 5), [3, 4, 5], '"3:*" runs to the largest');
  // Negative control: treating "*" as literal 1.
  assert.deepEqual(parseSequenceSet('*', 5, { starIsLiteralOne: true }), [1], 'starIsLiteralOne must be detectable');
});

test('R-9051-2.3.1.1-d: ranges are order-independent (rangeNotCommutative caught)', () => {
  cites('R-9051-2.3.1.1-d');
  assert.deepEqual(parseSequenceSet('10:12', 20), [10, 11, 12]);
  assert.deepEqual(parseSequenceSet('12:10', 20), [10, 11, 12], '"12:10" == "10:12"');
  // Negative control: a high:low range treated as empty.
  assert.deepEqual(parseSequenceSet('12:10', 20, { rangeNotCommutative: true }), [], 'rangeNotCommutative must be detectable');
});
