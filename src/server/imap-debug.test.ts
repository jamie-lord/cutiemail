/**
 * IMAP debug-log credential redaction (audit run-1, finding 7). MAIL_DEBUG logs each
 * received line; the redactor must cover BOTH auth forms and the SASL continuation, or a
 * base64 that decodes to \0user\0password lands in the journal. Each redaction is paired
 * with a non-credential line that must pass through unchanged (no over-redaction).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactImapDebugLine } from './imap-server.ts';

test('the LOGIN password is redacted; the username and command are kept', () => {
  assert.equal(redactImapDebugLine('a1 LOGIN alice s3cr3t', false), 'a1 LOGIN alice ***');
  assert.equal(redactImapDebugLine('a1 login alice s3cr3t', false), 'a1 login alice ***'); // case-insensitive
});

test('the AUTHENTICATE PLAIN inline base64 is redacted (the form real clients use)', () => {
  // AGFsaWNlAHMzY3Jl decodes to \0alice\0s3cre — must never reach the log.
  const line = 'a1 AUTHENTICATE PLAIN AGFsaWNlAHMzY3Jl';
  const out = redactImapDebugLine(line, false);
  assert.equal(out, 'a1 AUTHENTICATE PLAIN ***');
  assert.equal(out.includes('AGFsaWNl'), false, 'the base64 credential is gone');
});

test('a standalone SASL continuation response is redacted wholesale', () => {
  // A bare base64 line (the continuation) has no command structure for a regex to anchor on.
  assert.equal(redactImapDebugLine('AGFsaWNlAHMzY3Jl', true), '<SASL response redacted>');
  assert.equal(redactImapDebugLine('AGFsaWNlAHMzY3Jl', true).includes('AGFsaWNl'), false);
});

test('non-credential lines pass through unchanged (no over-redaction)', () => {
  for (const line of ['a1 SELECT INBOX', 'a2 FETCH 1:* (FLAGS)', 'a3 CAPABILITY', 'a4 UID SEARCH SUBJECT hello']) {
    assert.equal(redactImapDebugLine(line, false), line);
  }
});
