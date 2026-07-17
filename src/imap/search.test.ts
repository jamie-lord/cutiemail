/**
 * The IMAP SEARCH corpus (RFC 9051 §6.4.4), with a negative control. Proves multiple
 * search keys are ANDed — a message matches only if every key matches — with the
 * orSemantics defect DETECTED. Cites a compile-checked ImapRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch } from './search.ts';
import type { SearchableMessage, SearchKey } from './search.ts';
import { parseMessage } from '../message/parse.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);
const CRLF = '\r\n';

const msg = (from: string, subject: string, flags: string[]): SearchableMessage => {
  const raw = Buffer.from(`From: ${from}${CRLF}Subject: ${subject}${CRLF}${CRLF}body`, 'latin1');
  return { headers: parseMessage(raw).headers, flags: new Set(flags), internalDate: 0, raw, uid: 1, seq: 1, modseq: 1 };
};

const header = (name: string, value: string): SearchKey => ({ type: 'header', name, value });

test('sanity: individual keys match', () => {
  const m = msg('smith@example.com', 'Quarterly report', ['\\Seen']);
  assert.ok(matchesSearch(m, [header('from', 'smith')]));
  assert.ok(matchesSearch(m, [header('subject', 'report')]));
  assert.ok(matchesSearch(m, [{ type: 'flag', flag: '\\Seen', present: true }]));
  assert.ok(!matchesSearch(m, [{ type: 'flag', flag: '\\Seen', present: false }]));
});

test('NOT inverts and OR unions (the keys the old parser silently dropped)', () => {
  const seen = msg('a@example.com', 'hi', ['\\Seen']);
  const unseen = msg('b@example.com', 'hi', []);
  // NOT SEEN matches the unseen message, not the seen one.
  assert.ok(matchesSearch(unseen, [{ type: 'not', key: { type: 'flag', flag: '\\Seen', present: true } }]));
  assert.ok(!matchesSearch(seen, [{ type: 'not', key: { type: 'flag', flag: '\\Seen', present: true } }]));
  // OR FROM a FROM b matches either sender.
  const or: SearchKey = { type: 'or', a: header('from', 'a@example.com'), b: header('from', 'zzz') };
  assert.ok(matchesSearch(seen, [or]));
  assert.ok(!matchesSearch(unseen, [or]));
});

test('R-9051-6.4.4-a: multiple keys are ANDed (orSemantics caught)', () => {
  cites('R-9051-6.4.4-a');
  const m = msg('smith@example.com', 'Quarterly report', ['\\Seen']);
  const keys: SearchKey[] = [header('from', 'smith'), header('subject', 'report')];
  assert.ok(matchesSearch(m, keys), 'a message matching both keys matches');

  // A message matching only ONE key must NOT match under AND.
  const partial = msg('jones@example.com', 'Quarterly report', ['\\Seen']);
  assert.ok(!matchesSearch(partial, keys), 'matching only one key is not enough (AND)');

  // Negative control: OR semantics wrongly matches the partial message.
  assert.ok(matchesSearch(partial, keys, { orSemantics: true }), 'orSemantics must be detectable');
});
