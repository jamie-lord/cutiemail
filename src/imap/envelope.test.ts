/**
 * The IMAP ENVELOPE corpus (RFC 9051 §7.5.2), with negative controls. Proves the
 * formatter emits the fixed field order and defaults Sender/Reply-To to From, with
 * each rule's defect DETECTED. Built on real parsed headers. Cites compile-checked
 * ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, serializeEnvelope } from './envelope.ts';
import type { EnvelopeAddress } from './envelope.ts';
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

test('a folded Subject is unfolded so the ENVELOPE has no embedded CR/LF', () => {
  // Real senders fold long headers (RFC 5322 §2.2.3). An IMAP quoted string cannot
  // contain CR/LF, so a folded value emitted verbatim would desync the client parser.
  const folded = parseMessage(
    Buffer.from(`Subject: A long subject the sender${CRLF} folded across two lines${CRLF}From: a@x.test${CRLF}${CRLF}body`, 'latin1'),
  ).headers;
  const byName = new Map(buildEnvelope(folded).fields.map((f) => [f.name, f.value]));
  assert.equal(byName.get('subject'), 'A long subject the sender folded across two lines', 'the fold is removed, not left as a raw CRLF');
  const wire = serializeEnvelope(buildEnvelope(folded));
  assert.doesNotMatch(wire, /[\r\n]/, 'the serialized ENVELOPE contains no CR or LF');
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

test('a quoted display-name with a comma is one address, not split on the inner comma', () => {
  // "Lastname, Firstname" is extremely common; a naive comma-split mangles it.
  const headers = parseMessage(
    Buffer.from('From: "Doe, John" <john@example.com>\r\nTo: "Roe, Jane" <jane@example.net>, plain@example.org\r\nSubject: x\r\n\r\nb\r\n', 'latin1'),
  ).headers;
  const env = buildEnvelope(headers);
  const from = env.fields.find((f) => f.name === 'from')!.value as { name: string | null; mailbox: string; host: string }[];
  assert.equal(from.length, 1, 'the From is a single address despite the comma in the display name');
  assert.deepEqual(from[0], { name: 'Doe, John', mailbox: 'john', host: 'example.com' });

  const to = env.fields.find((f) => f.name === 'to')!.value as { name: string | null; mailbox: string; host: string }[];
  assert.equal(to.length, 2, 'the two genuinely-separate To addresses still split');
  assert.equal(to[0]!.name, 'Roe, Jane');
  assert.equal(to[1]!.mailbox, 'plain');
});

const addrs = (headers: readonly import('../message/model.ts').Header[], field: string, defects = {}): EnvelopeAddress[] =>
  buildEnvelope(headers, defects).fields.find((f) => f.name === field)!.value as EnvelopeAddress[];

test('RFC 9051 §7.5.2: an RFC 5322 group address emits start/end markers with clean hosts (noGroupMarkers caught)', () => {
  cites('R-9051-7.5.2-a');
  const headers = parseMessage(
    Buffer.from(`From: a@x.test${CRLF}To: A Group: alice@x.test, bob@y.test;${CRLF}Subject: x${CRLF}${CRLF}body`, 'latin1'),
  ).headers;

  const to = addrs(headers, 'to');
  // Start marker (NIL NIL "A Group" NIL), the two members, then end marker (NIL NIL NIL NIL).
  assert.deepEqual(to[0], { name: null, mailbox: 'A Group', host: '' }, 'group start marker carries the group name, NIL host');
  assert.deepEqual(to[1], { name: null, mailbox: 'alice', host: 'x.test' }, 'first member, group name not glued on');
  assert.deepEqual(to[2], { name: null, mailbox: 'bob', host: 'y.test' }, "last member's host is clean, no leaked ';'");
  assert.deepEqual(to[3], { name: null, mailbox: null, host: null }, 'group end marker is all-NIL');
  assert.equal(to.length, 4);

  const wire = serializeEnvelope(buildEnvelope(headers));
  assert.match(wire, /\(NIL NIL "A Group" NIL\)/, 'the group start marker serializes with a NIL host');
  assert.match(wire, /\(NIL NIL NIL NIL\)/, 'the group end marker serializes all-NIL');
  assert.doesNotMatch(wire, /y\.test;/, "the closing ';' never leaks into a host");

  // Negative control: without group markers the old corruption returns — the group name
  // glues onto the first mailbox and the ';' leaks into the last host.
  const broken = addrs(headers, 'to', { noGroupMarkers: true });
  assert.ok(
    broken.some((a) => (a.host ?? '').includes(';') || (a.mailbox ?? '').includes(' ')),
    'noGroupMarkers must be detectable (group name glued / semicolon leaked)',
  );
  assert.ok(!broken.some((a) => a.mailbox === null), 'the defect emits no end marker');
});

test('RFC 9051 §7.5.2: an undisclosed-recipients empty group is a start marker then an immediate end marker', () => {
  cites('R-9051-7.5.2-a');
  const headers = parseMessage(
    Buffer.from(`From: a@x.test${CRLF}To: undisclosed-recipients:;${CRLF}Subject: x${CRLF}${CRLF}body`, 'latin1'),
  ).headers;
  const to = addrs(headers, 'to');
  assert.deepEqual(to[0], { name: null, mailbox: 'undisclosed-recipients', host: '' }, 'the empty group opens with its name');
  assert.deepEqual(to[1], { name: null, mailbox: null, host: null }, 'and closes immediately with the end marker');
  assert.equal(to.length, 2, 'an empty group has no members between the markers');
});
