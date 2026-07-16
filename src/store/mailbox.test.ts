/**
 * The mailbox UID-semantics corpus (RFC 9051 §2.3.1.1), with negative controls.
 * Property-style: proves the reference mailbox keeps UIDs strictly ascending and
 * never reuses one (even across expunge), with each rule's defect DETECTED. Cites
 * compile-checked ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from './mailbox.ts';
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
