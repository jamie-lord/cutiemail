/**
 * Bounce (non-delivery report) assembly — RFC 3462/3464. The bounce is a
 * multipart/report carrying a human-readable explanation, the machine-readable
 * message/delivery-status, and the returned original message. Pins the structure a
 * receiving MUA (and an automated processor) expects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBounceMessage } from './bounce.ts';
import { parseMessage } from '../message/parse.ts';
import { analyzeMime } from '../message/mime.ts';

test('a bounce is a well-formed multipart/report with the three required parts', () => {
  const original = Buffer.from('From: alice@example.com\r\nTo: nobody@remote.test\r\nSubject: hello\r\n\r\nthe original body\r\n', 'latin1');
  const bounce = buildBounceMessage({
    reportingMta: 'mx.example.test',
    originalSender: 'alice@example.com',
    originalData: original,
    failures: [{ recipient: 'nobody@remote.test', action: 'failed', status: '5.1.1', detail: '550 no such user' }],
    date: 'Wed, 15 Jul 2026 09:30:00 +0000',
    token: 'abc123',
  });

  const parsed = parseMessage(bounce);
  const mime = analyzeMime(parsed.headers);
  assert.equal(mime.contentType.type, 'multipart', 'the top type is multipart');
  assert.equal(mime.contentType.subtype, 'report', 'the subtype is report');

  const text = bounce.toString('latin1');
  // The null-return-path recipient is the original sender.
  assert.match(text, /^To: <alice@example\.com>/m, 'addressed to the original sender');
  assert.match(text, /^From: Mail Delivery System <MAILER-DAEMON@mx\.example\.test>/m, 'from MAILER-DAEMON');
  assert.match(text, /Auto-Submitted: auto-replied/m, 'marked auto-submitted so it does not trigger auto-responders');
  // The three body parts.
  assert.match(text, /Content-Type: text\/plain/, 'a human-readable part');
  assert.match(text, /Content-Type: message\/delivery-status/, 'the machine-readable delivery-status part');
  assert.match(text, /Content-Type: message\/rfc822/, 'the returned original message part');
  // The delivery-status body carries the required per-recipient fields.
  assert.match(text, /Reporting-MTA: dns; mx\.example\.test/, 'the Reporting-MTA is reported');
  assert.match(text, /Final-Recipient: rfc822; nobody@remote\.test/, 'the failed recipient is reported');
  assert.match(text, /Action: failed/, 'the action is failed');
  assert.match(text, /Status: 5\.1\.1/, 'the RFC 3463 status is carried');
  // The original message is returned intact.
  assert.match(text, /the original body/, 'the original message is included');
});

test('the bounce carries a Received trace header and a Diagnostic-Code from the remote reply', () => {
  const original = Buffer.from('From: alice@example.com\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const bounce = buildBounceMessage({
    reportingMta: 'mx.example.test',
    originalSender: 'alice@example.com',
    originalData: original,
    failures: [{ recipient: 'nobody@remote.test', action: 'failed', status: '5.1.1', detail: '550 5.1.1 no such user' }],
    date: 'Wed, 15 Jul 2026 09:30:00 +0000',
    token: 'abc123',
  });
  const text = bounce.toString('latin1');
  // A trace header the integrator's DKIM signer can oversign - and it is at the very top.
  assert.match(text, /^Received: by mx\.example\.test \(cutiemail\) id abc123; Wed, 15 Jul 2026 09:30:00 \+0000\r\n/, 'a Received header leads the message');
  assert.ok(text.indexOf('Received:') < text.indexOf('From:'), 'the Received trace precedes the originator fields');
  // The remote reply (detail) is now surfaced to the sender as a Diagnostic-Code.
  assert.match(text, /Diagnostic-Code: smtp; 550 5\.1\.1 no such user/, 'the remote failure reason reaches the sender');
});
