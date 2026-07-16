/**
 * The IMAP mailbox-name corpus (RFC 9051 §5.1), with a negative control. Proves
 * INBOX matches case-insensitively while other names are case-sensitive, with the
 * caseSensitiveInbox defect DETECTED. Cites a compile-checked ImapRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMailboxName, sameMailbox } from './mailbox-name.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('R-9051-5.1-a: INBOX is case-insensitive; other names are case-sensitive (caseSensitiveInbox caught)', () => {
  cites('R-9051-5.1-a');
  // Any casing of INBOX canonicalises to "INBOX".
  for (const n of ['INBOX', 'inbox', 'InBoX']) assert.equal(canonicalMailboxName(n), 'INBOX', `${n} is INBOX`);
  assert.ok(sameMailbox('inbox', 'INBOX'), 'inbox and INBOX are the same mailbox');
  // Non-INBOX names are case-sensitive.
  assert.equal(canonicalMailboxName('Sent'), 'Sent', 'other names keep their case');
  assert.ok(!sameMailbox('Sent', 'sent'), 'Sent and sent are distinct mailboxes');

  // Negative control: treating INBOX case-sensitively strands the primary mailbox.
  assert.ok(!sameMailbox('inbox', 'INBOX', { caseSensitiveInbox: true }), 'caseSensitiveInbox must be detectable');
});
