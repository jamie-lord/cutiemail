/**
 * The DSN message/delivery-status corpus (RFC 3464 §2.3), with negative controls.
 * Round-trips generation through validation: a conformant DSN validates, and each
 * defect that omits/corrupts a required field is DETECTED. Cites compile-checked
 * MessageRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeliveryStatus, validateDeliveryStatus } from './dsn.ts';
import type { RecipientStatus } from './dsn.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

const RECIPIENTS: RecipientStatus[] = [
  { recipient: 'alice@example.net', action: 'failed', status: '5.1.1' },
  { recipient: 'bob@example.org', action: 'delayed', status: '4.4.1' },
];

test('sanity: a generated delivery-status validates and carries the fields', () => {
  const body = generateDeliveryStatus('mail.example.com', RECIPIENTS);
  const text = body.toString('latin1');
  assert.ok(text.startsWith('Reporting-MTA: dns; mail.example.com'), 'the per-message group leads');
  assert.ok(text.includes('Final-Recipient: rfc822; alice@example.net'));
  assert.ok(text.includes('Action: failed'));
  assert.ok(validateDeliveryStatus(body).valid);
});

test('R-3464-2.3.2-a: every per-recipient group has a Final-Recipient (omitFinalRecipient caught)', () => {
  cites('R-3464-2.3.2-a');
  assert.ok(validateDeliveryStatus(generateDeliveryStatus('m.example.com', RECIPIENTS)).valid, 'conformant has Final-Recipient');
  // Negative control: omitting it is detected by the validator.
  const bad = generateDeliveryStatus('m.example.com', RECIPIENTS, { omitFinalRecipient: true });
  const v = validateDeliveryStatus(bad);
  assert.ok(!v.valid && v.anomalies.some((a) => a.startsWith('missing-final-recipient')), 'omitFinalRecipient must be detectable');
});

test('R-3464-2.3.3-a: every recipient has a valid Action (omit/invalid caught)', () => {
  cites('R-3464-2.3.3-a');
  assert.ok(validateDeliveryStatus(generateDeliveryStatus('m.example.com', RECIPIENTS)).valid, 'conformant has valid Actions');
  // Negative control 1: a missing Action.
  const missing = validateDeliveryStatus(generateDeliveryStatus('m.example.com', RECIPIENTS, { omitAction: true }));
  assert.ok(!missing.valid && missing.anomalies.some((a) => a.startsWith('missing-action')), 'omitAction must be detectable');
  // Negative control 2: an Action outside the defined set.
  const invalid = validateDeliveryStatus(generateDeliveryStatus('m.example.com', RECIPIENTS, { invalidAction: true }));
  assert.ok(!invalid.valid && invalid.anomalies.some((a) => a.startsWith('invalid-action')), 'invalidAction must be detectable');
});
