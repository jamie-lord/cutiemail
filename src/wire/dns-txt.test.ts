/**
 * DNS TXT character-string reassembly (RFC 1035 §3.3.14), the join that MTA-STS (RFC 8461 §3.1),
 * SPF (RFC 7208 §3.3) and DKIM key records (RFC 6376 §3.6.2.2) all depend on. The requirement is
 * "concatenated without adding spaces"; the negative control is the space-joined form, which is the
 * mistake the rule exists to forbid — it corrupts whichever field straddles a 255-octet split.
 *
 * This was `deliberatelyUncovered` while the join lived inline in main.ts's DNS adapter; extracting
 * it into `joinTxtRecord` is the production change the decision recorded as its blocker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinTxtRecord } from './dns-txt.ts';
import { transportRequirement } from '../register/transport/index.ts';
import type { TransportRequirementId } from '../register/transport/index.ts';

const cites = (id: TransportRequirementId): void => assert.ok(transportRequirement(id).id === id);

test('R-8461-3.1-c: multiple TXT strings are concatenated with NO separator', () => {
  cites('R-8461-3.1-c');
  // A single string is returned unchanged.
  assert.equal(joinTxtRecord(['v=STSv1; id=20210001']), 'v=STSv1; id=20210001');
  // A value split across the 255-octet boundary is rejoined seamlessly — the split falls INSIDE the
  // id, so any separator would corrupt it.
  assert.equal(joinTxtRecord(['v=STSv1; id=2021', '0001abcdef']), 'v=STSv1; id=20210001abcdef');
  // An empty record is the empty string, not a stray separator.
  assert.equal(joinTxtRecord([]), '');
  assert.equal(joinTxtRecord(['', '']), '');
});

test('the space-joined form (the forbidden one) would corrupt a straddling field — negative control', () => {
  // This is what "without adding spaces" forbids: had the join used a space, the reassembled id would
  // carry an interior space and no longer match the STS policy (or a DKIM `p=` / SPF term that split).
  const chunks = ['v=STSv1; id=2021', '0001'];
  assert.equal(joinTxtRecord(chunks), 'v=STSv1; id=20210001', 'the correct join is seamless');
  assert.notEqual(chunks.join(' '), joinTxtRecord(chunks), 'a space join produces a different, corrupted value');
  assert.notEqual(chunks.join(','), joinTxtRecord(chunks), 'and so does the Array.join default (comma)');
});
