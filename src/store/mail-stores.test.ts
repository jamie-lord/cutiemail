/**
 * The per-user store cache (ADR 0009). Its one invariant: all of a user's IMAP connections AND
 * that user's inbound deliveries share ONE catalog + notifier instance. A second instance is not
 * a performance problem — it silently breaks IDLE push, because delivery signals one notifier
 * while a session waits on the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailStores } from './mail-stores.ts';
import { MemoryCatalog } from './memory-catalog.ts';
import { MailboxNotifier } from '../server/mailbox-notifier.ts';

const opener = (opened: string[]) => (login: string) => {
  if (login.toLowerCase() === 'nobody') return undefined;
  opened.push(login);
  return { catalog: new MemoryCatalog(), notifier: new MailboxNotifier() };
};

test('one instance per user, opened once and reused', () => {
  const opened: string[] = [];
  const stores = new MailStores(opener(opened));
  assert.equal(stores.get('alice'), stores.get('alice'), 'the same login gets the same instance');
  assert.notEqual(stores.get('alice'), stores.get('bob'), 'different logins get different instances');
  assert.deepEqual(opened, ['alice', 'bob'], 'each account is opened exactly once');
});

test('a login differing only in case shares one instance (case-insensitive identity)', () => {
  // A client may send any casing of the username. Keying the cache on the raw string handed that
  // session its own catalog AND notifier over the same account, so it authenticated and read
  // existing mail normally and then never received an EXISTS push again.
  const opened: string[] = [];
  const stores = new MailStores(opener(opened));
  const canonical = stores.get('alice');
  for (const spelling of ['Alice', 'ALICE', 'aLiCe']) {
    assert.equal(stores.get(spelling), canonical, `${spelling} shares alice's instance`);
  }
  assert.deepEqual(opened, ['alice'], 'the account is opened once, not once per spelling');
});

test('an unknown account is not cached, so it is retried rather than pinned to undefined', () => {
  const opened: string[] = [];
  const stores = new MailStores(opener(opened));
  assert.equal(stores.get('nobody'), undefined);
  assert.equal(stores.get('NOBODY'), undefined, 'and stays undefined whatever the case');
  assert.deepEqual(opened, [], 'nothing was cached');
});
