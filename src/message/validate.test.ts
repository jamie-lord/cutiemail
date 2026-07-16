/**
 * The RFC 5322 §3.6 field-validation corpus, with negative controls.
 *
 * Same discipline as parse.test.ts: each requirement is proven conformant on a
 * well-formed message AND detected against the defect that would miss it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from './parse.ts';
import { validateFields, hasViolation } from './validate.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const CRLF = '\r\n';
const b = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

const DATE = 'Date: Thu, 16 Jul 2026 12:00:00 +0000';
const FROM = 'From: a@example.com';

test('sanity: a message with Date + From and no duplicates is clean', () => {
  const msg = parseMessage(b(`${DATE}${CRLF}${FROM}${CRLF}Subject: hi${CRLF}${CRLF}body`));
  assert.deepEqual(validateFields(msg), []);
});

test('R-5322-3.6-a: a missing Date or From is flagged (and the defect is caught)', () => {
  cites('R-5322-3.6-a');
  const noDate = parseMessage(b(`${FROM}${CRLF}Subject: hi${CRLF}${CRLF}body`));
  const noFrom = parseMessage(b(`${DATE}${CRLF}Subject: hi${CRLF}${CRLF}body`));

  assert.ok(hasViolation(validateFields(noDate), 'missing-date'), 'clean validator flags a missing Date');
  assert.ok(hasViolation(validateFields(noFrom), 'missing-from'), 'clean validator flags a missing From');

  // Negative control.
  assert.ok(!hasViolation(validateFields(noDate, { skipRequiredCheck: true }), 'missing-date'), 'skipRequiredCheck must be detectable');
  assert.ok(!hasViolation(validateFields(noFrom, { skipRequiredCheck: true }), 'missing-from'), 'skipRequiredCheck must be detectable');
});

test('R-5322-3.6-b: a duplicate singleton (two From) is flagged (and the defect is caught)', () => {
  cites('R-5322-3.6-b');
  const twoFrom = parseMessage(b(`${DATE}${CRLF}${FROM}${CRLF}From: b@example.com${CRLF}${CRLF}body`));

  assert.ok(hasViolation(validateFields(twoFrom), 'duplicate-singleton', 'from'), 'clean validator flags two From fields');

  // Negative control.
  assert.ok(!hasViolation(validateFields(twoFrom, { allowDuplicateSingletons: true }), 'duplicate-singleton'), 'allowDuplicateSingletons must be detectable');
});

test('R-5322-3.6-b: a repeated NON-singleton (two Comments) is NOT a violation', () => {
  cites('R-5322-3.6-b');
  // Comments/keywords/optional-field are unlimited — a validator must not flag them.
  const twoComments = parseMessage(b(`${DATE}${CRLF}${FROM}${CRLF}Comments: one${CRLF}Comments: two${CRLF}${CRLF}body`));
  assert.deepEqual(validateFields(twoComments), [], 'a repeated non-singleton field must not be flagged');
});
