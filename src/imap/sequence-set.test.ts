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

test('repeated and overlapping ranges cost what the messages cost, not what the ranges cost', () => {
  // The result was always a Set, so the OUTPUT was de-duplicated — but the enumeration ran once
  // PER RANGE, so N ranges each walked up to `largest`: O(ranges x largest). A 64 KB command
  // repeating `1:*` sixteen thousand times against a 20,000-message mailbox blocked the single
  // event loop for over three seconds, for every account on the server, and was repeatable at
  // will. Merging the intervals first makes the cost proportional to the messages designated.
  const largest = 20_000;
  const repeated = Array.from({ length: 4000 }, () => '1:*').join(',');

  const started = Date.now();
  const out = parseSequenceSet(repeated, largest);
  const elapsed = Date.now() - started;

  assert.equal(out.length, largest, 'the answer is still every message');
  assert.equal(out[0], 1);
  assert.equal(out[out.length - 1], largest);
  assert.ok(elapsed < 1000, `4000 repeats of 1:* took ${elapsed}ms — enumeration must be merged`);

  // Overlapping-but-distinct ranges collapse too; string de-duplication alone would not catch these.
  const overlapping = Array.from({ length: 4000 }, (_, i) => `${i + 1}:${largest}`).join(',');
  const started2 = Date.now();
  const out2 = parseSequenceSet(overlapping, largest);
  assert.equal(out2.length, largest, 'overlapping ranges still designate every message');
  assert.ok(Date.now() - started2 < 1000, 'overlapping ranges are merged, not enumerated one by one');
});
