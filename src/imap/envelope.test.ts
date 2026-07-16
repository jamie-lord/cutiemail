/**
 * The IMAP ENVELOPE corpus (RFC 9051 §7.5.2), with negative controls. Proves the
 * formatter emits the fixed field order and defaults Sender/Reply-To to From, with
 * each rule's defect DETECTED. Built on real parsed headers. Cites compile-checked
 * ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope } from './envelope.ts';
import { parseMessage } from '../message/parse.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);
const CRLF = '\r\n';

const MESSAGE = parseMessage(
  Buffer.from(
    `Date: Wed, 15 Jul 2026 09:30:00 +0100${CRLF}` +
      `Subject: Hello${CRLF}` +
      `From: Alice <alice@example.com>${CRLF}` +
      `To: Bob <bob@example.net>${CRLF}` +
      `Message-ID: <abc@example.com>${CRLF}${CRLF}body`,
    'latin1',
  ),
).headers;

const ORDER = ['date', 'subject', 'from', 'sender', 'reply-to', 'to', 'cc', 'bcc', 'in-reply-to', 'message-id'];

test('sanity: ENVELOPE fields are built from the parsed headers', () => {
  const env = buildEnvelope(MESSAGE);
  const byName = new Map(env.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.get('subject'), 'Hello');
  const from = byName.get('from') as { name: string | null; mailbox: string; host: string }[];
  assert.deepEqual(from[0], { name: 'Alice', mailbox: 'alice', host: 'example.com' });
  assert.equal(byName.get('cc'), null, 'an absent Cc is NIL');
});

test('R-9051-7.5.2-a: the ten fields are in the defined order (wrongFieldOrder caught)', () => {
  cites('R-9051-7.5.2-a');
  assert.deepEqual(buildEnvelope(MESSAGE).fields.map((f) => f.name), ORDER, 'the fixed ENVELOPE order');
  // Negative control.
  assert.notDeepEqual(buildEnvelope(MESSAGE, { wrongFieldOrder: true }).fields.map((f) => f.name), ORDER, 'wrongFieldOrder must be detectable');
});

test('R-9051-7.5.2-b: absent Sender/Reply-To default to From (nilAbsentSender caught)', () => {
  cites('R-9051-7.5.2-b');
  const env = buildEnvelope(MESSAGE);
  const byName = new Map(env.fields.map((f) => [f.name, f.value]));
  assert.deepEqual(byName.get('sender'), byName.get('from'), 'absent Sender defaults to From');
  assert.deepEqual(byName.get('reply-to'), byName.get('from'), 'absent Reply-To defaults to From');
  // Negative control: leaving them NIL.
  const defect = new Map(buildEnvelope(MESSAGE, { nilAbsentSender: true }).fields.map((f) => [f.name, f.value]));
  assert.equal(defect.get('sender'), null, 'nilAbsentSender must be detectable');
});
