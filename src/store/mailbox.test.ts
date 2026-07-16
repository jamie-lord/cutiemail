/**
 * The mailbox UID-semantics corpus (RFC 9051 §2.3.1.1), with negative controls.
 * Property-style: proves the reference mailbox keeps UIDs strictly ascending and
 * never reuses one (even across expunge), with each rule's defect DETECTED. Cites
 * compile-checked ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, DELETED } from './mailbox.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);
const b = (s: string): Buffer => Buffer.from(s, 'latin1');

test('sanity: appended messages are stored byte-exact with their UID', () => {
  const mb = new Mailbox(42);
  const uid = mb.append(b('hello'), ['\\Seen'], 1000);
  assert.equal(uid, 1);
  assert.equal(mb.uidValidity, 42);
  assert.equal(mb.messages[0]!.raw.toString('latin1'), 'hello');
  assert.ok(mb.messages[0]!.flags.has('\\Seen'));
});

test('R-9051-2.3.1.1-a: UIDs are strictly ascending (nonAscendingUid caught)', () => {
  cites('R-9051-2.3.1.1-a');
  const mb = new Mailbox();
  const uids = [mb.append(b('a')), mb.append(b('b')), mb.append(b('c'))];
  assert.deepEqual(uids, [1, 2, 3]);
  for (let i = 1; i < uids.length; i++) assert.ok(uids[i]! > uids[i - 1]!, 'each UID is higher than the last');

  // Negative control: a mailbox that does not advance the counter reuses UIDs.
  const defect = new Mailbox(1, { nonAscendingUid: true });
  const bad = [defect.append(b('a')), defect.append(b('b')), defect.append(b('c'))];
  assert.ok(bad.some((u, i) => i > 0 && u <= bad[i - 1]!), 'nonAscendingUid must be detectable');
});

test('R-9051-2.3.1.1-b: an expunged UID is never reused (reuseExpungedUid caught)', () => {
  cites('R-9051-2.3.1.1-b');
  const mb = new Mailbox();
  const first = mb.append(b('one')); // uid 1
  mb.expunge(first);
  const second = mb.append(b('two')); // must be 2, not 1
  assert.equal(second, 2, 'the UID after an expunge is not reused');
  assert.ok(mb.uidNext > second, 'UIDNEXT keeps advancing');

  // Negative control: rolling UIDNEXT back on expunge reuses the UID.
  const defect = new Mailbox(1, { reuseExpungedUid: true });
  const u1 = defect.append(b('one'));
  defect.expunge(u1);
  const u2 = defect.append(b('two'));
  assert.equal(u2, u1, 'reuseExpungedUid must be detectable');
});

test('R-9051-2.3.2-a: STORE add sets a flag and remove clears it (removeDoesntClear caught)', () => {
  cites('R-9051-2.3.2-a');
  const mb = new Mailbox();
  const uid = mb.append(b('m'));
  mb.storeFlags(uid, 'add', ['\\Seen']);
  assert.ok(mb.messages[0]!.flags.has('\\Seen'), 'add sets the flag');
  mb.storeFlags(uid, 'add', ['\\Seen']); // idempotent
  assert.equal(mb.messages[0]!.flags.size, 1, 'a set — no duplicate');
  mb.storeFlags(uid, 'remove', ['\\Seen']);
  assert.ok(!mb.messages[0]!.flags.has('\\Seen'), 'remove clears it');

  // Negative control: a no-op removal.
  const defect = new Mailbox(1, { removeDoesntClear: true });
  const u = defect.append(b('m'));
  defect.storeFlags(u, 'add', ['\\Seen']);
  defect.storeFlags(u, 'remove', ['\\Seen']);
  assert.ok(defect.messages[0]!.flags.has('\\Seen'), 'removeDoesntClear must be detectable');
});

test('R-9051-2.3.2-b: EXPUNGE removes exactly the \\Deleted messages (expungeIgnoresDeleted caught)', () => {
  cites('R-9051-2.3.2-b');
  const mb = new Mailbox();
  const keep = mb.append(b('keep'));
  const drop = mb.append(b('drop'));
  mb.storeFlags(drop, 'add', [DELETED]);
  const removed = mb.expungeDeleted();
  assert.deepEqual([...removed], [drop], 'the \\Deleted message is expunged');
  assert.equal(mb.messages.length, 1, 'the un-flagged message stays');
  assert.equal(mb.messages[0]!.uid, keep);

  // Negative control: EXPUNGE that ignores \Deleted removes nothing.
  const defect = new Mailbox(1, { expungeIgnoresDeleted: true });
  const d = defect.append(b('drop'));
  defect.storeFlags(d, 'add', [DELETED]);
  assert.equal(defect.expungeDeleted().length, 0, 'expungeIgnoresDeleted must be detectable');
  assert.equal(defect.messages.length, 1, 'the \\Deleted message wrongly remains');
});

test('R-9051-2.3.1.2-a: sequence numbers are ordered by ascending UID (seqNumsDescending caught)', () => {
  cites('R-9051-2.3.1.2-a');
  const mb = new Mailbox();
  const [a, , c] = [mb.append(b('a')), mb.append(b('b')), mb.append(b('c'))];
  assert.equal(mb.sequenceNumber(a), 1, 'lowest UID is seq 1');
  assert.equal(mb.sequenceNumber(c), 3, 'highest UID is seq 3');
  // Negative control: descending order flips the positions.
  const defect = new Mailbox(1, { seqNumsDescending: true });
  const da = defect.append(b('a'));
  defect.append(b('b'));
  defect.append(b('c'));
  assert.notEqual(defect.sequenceNumber(da), 1, 'seqNumsDescending must be detectable');
});

test('R-9051-2.3.1.2-b: EXPUNGE decrements subsequent sequence numbers (staleSeqNumsAfterExpunge caught)', () => {
  cites('R-9051-2.3.1.2-b');
  const mb = new Mailbox();
  const first = mb.append(b('a')); // seq 1
  const second = mb.append(b('b')); // seq 2
  assert.equal(mb.sequenceNumber(second), 2);
  mb.expunge(first); // the second message is now seq 1
  assert.equal(mb.sequenceNumber(second), 1, 'the later message renumbers down');

  // Negative control: keeping the expunged message counted leaves it stale.
  const defect = new Mailbox(1, { staleSeqNumsAfterExpunge: true });
  const f = defect.append(b('a'));
  const s = defect.append(b('b'));
  defect.expunge(f);
  assert.equal(defect.sequenceNumber(s), 2, 'staleSeqNumsAfterExpunge must be detectable');
});
