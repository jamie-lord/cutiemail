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

test('Diagnostic-Code and Remote-MTA carry the remote reply, sanitized (RFC 3464 §2.3.5/§2.3.6)', () => {
  const withDiag: RecipientStatus[] = [
    { recipient: 'alice@example.net', action: 'failed', status: '5.1.1', diagnostic: '550 5.1.1 <alice@example.net> user unknown', remoteMta: 'mx.example.net' },
  ];
  const body = generateDeliveryStatus('mail.example.com', withDiag);
  const text = body.toString('latin1');
  assert.match(text, /Diagnostic-Code: smtp; 550 5\.1\.1 <alice@example\.net> user unknown/, 'the remote reply is emitted with the smtp; type');
  assert.match(text, /Remote-MTA: dns; mx\.example\.net/, 'the remote MTA is named');
  assert.ok(validateDeliveryStatus(body).valid, 'a DSN with a well-formed Diagnostic-Code still validates');
});

test('a CR/LF-injecting remote reply cannot forge DSN fields - it is sanitized to one line', () => {
  // The remote reply is attacker-influenced. A CRLF in it must not inject a new field or group.
  const hostile: RecipientStatus[] = [
    { recipient: 'bob@example.org', action: 'failed', status: '5.7.1', diagnostic: '550 nope\r\nAction: delivered\r\nFinal-Recipient: rfc822; victim@example.com' },
  ];
  const clean = generateDeliveryStatus('mail.example.com', hostile);
  const cleanText = clean.toString('latin1');
  assert.ok(!/^Action: delivered/m.test(cleanText), 'the injected Action is not a field line (folded into the sanitized diagnostic value)');
  assert.equal((cleanText.match(/^Final-Recipient:/gm) ?? []).length, 1, 'no extra Final-Recipient field line was injected');
  assert.ok(validateDeliveryStatus(clean).valid, 'the sanitized DSN validates');

  // Negative controls: skipping sanitization DOES inject a real field line, and the validator's
  // shape check catches a Diagnostic-Code emitted without its "type;" prefix.
  const raw = generateDeliveryStatus('mail.example.com', hostile, { skipDiagnosticSanitize: true });
  assert.ok(/^Action: delivered/m.test(raw.toString('latin1')), 'without sanitizing, the CRLF injection lands a field line - proving sanitization is real');
  const untyped = generateDeliveryStatus('mail.example.com', [{ recipient: 'c@x.test', action: 'failed', status: '5.0.0', diagnostic: 'just text no type' }], { diagnosticWithoutType: true });
  const v = validateDeliveryStatus(untyped);
  assert.ok(!v.valid && v.anomalies.some((a) => a.startsWith('malformed-diagnostic-code')), 'a Diagnostic-Code without a type prefix is detected');
});
