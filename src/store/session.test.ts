/**
 * The read-only-session corpus (RFC 9051 §6.3.3), with a negative control. Proves a
 * read-only (EXAMINE) session refuses every mutation and leaves the mailbox
 * unchanged, while a read-write session works and reads always do. Cites a
 * compile-checked ImapRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, DELETED } from './mailbox.ts';
import { MailboxSession } from './session.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);
const b = (s: string): Buffer => Buffer.from(s, 'latin1');

test('sanity: a read-write session can mutate; reads work in both modes', () => {
  const mb = new Mailbox();
  mb.append(b('m'));
  const rw = new MailboxSession(mb, false);
  assert.ok(rw.storeFlags(1, 'add', ['\\Seen']));
  assert.ok(rw.mailbox.messages[0]!.flags.has('\\Seen'));

  const ro = new MailboxSession(mb, true);
  assert.equal(ro.mailbox.messages.length, 1, 'reads work on a read-only session');
});

test('R-9051-6.3.3-a: a read-only session refuses all mutations (allowWriteWhenReadOnly caught)', () => {
  cites('R-9051-6.3.3-a');
  const mb = new Mailbox();
  mb.append(b('m'));
  mb.storeFlags(1, 'add', [DELETED]);

  const ro = new MailboxSession(mb, true);
  assert.equal(ro.storeFlags(1, 'add', ['\\Seen']), false, 'STORE is refused');
  assert.equal(ro.append(b('n')), null, 'APPEND is refused');
  assert.equal(ro.expunge(), null, 'EXPUNGE is refused');
  // The mailbox is unchanged: no \Seen, still one message (the \Deleted one not expunged).
  assert.ok(!mb.messages[0]!.flags.has('\\Seen'), 'no flag change leaked through');
  assert.equal(mb.messages.length, 1, 'no expunge leaked through');

  // Negative control: allowing writes on a read-only session mutates the mailbox.
  const defect = new MailboxSession(mb, true, { allowWriteWhenReadOnly: true });
  assert.ok(defect.storeFlags(1, 'add', ['\\Seen']), 'allowWriteWhenReadOnly must be detectable');
  assert.ok(mb.messages[0]!.flags.has('\\Seen'), 'the write leaked through under the defect');
});
