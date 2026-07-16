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

const msg = (from: string, subject: string, flags: string[]): SearchableMessage => ({
  headers: parseMessage(Buffer.from(`From: ${from}${CRLF}Subject: ${subject}${CRLF}${CRLF}body`, 'latin1')).headers,
  flags: new Set(flags),
});

test('sanity: individual keys match', () => {
  const m = msg('smith@example.com', 'Quarterly report', ['\\Seen']);
  assert.ok(matchesSearch(m, [{ type: 'from', value: 'smith' }]));
  assert.ok(matchesSearch(m, [{ type: 'subject', value: 'report' }]));
  assert.ok(matchesSearch(m, [{ type: 'seen' }]));
  assert.ok(!matchesSearch(m, [{ type: 'unseen' }]));
});

test('R-9051-6.4.4-a: multiple keys are ANDed (orSemantics caught)', () => {
  cites('R-9051-6.4.4-a');
  const m = msg('smith@example.com', 'Quarterly report', ['\\Seen']);
  const keys: SearchKey[] = [{ type: 'from', value: 'smith' }, { type: 'subject', value: 'report' }];
  assert.ok(matchesSearch(m, keys), 'a message matching both keys matches');

  // A message matching only ONE key must NOT match under AND.
  const partial = msg('jones@example.com', 'Quarterly report', ['\\Seen']);
  assert.ok(!matchesSearch(partial, keys), 'matching only one key is not enough (AND)');

  // Negative control: OR semantics wrongly matches the partial message.
  assert.ok(matchesSearch(partial, keys, { orSemantics: true }), 'orSemantics must be detectable');
});
