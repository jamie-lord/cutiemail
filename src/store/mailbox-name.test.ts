/**
 * The IMAP mailbox-name corpus (RFC 9051 §5.1), with a negative control. Proves
 * INBOX matches case-insensitively while other names are case-sensitive, with the
 * caseSensitiveInbox defect DETECTED. Cites a compile-checked ImapRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMailboxName, sameMailbox, subtreeRenames, MAX_MAILBOX_NAME_OCTETS, MAX_MAILBOX_SEGMENTS } from './mailbox-name.ts';
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

test('a subtree rename never stores a name the create path could not have produced', () => {
  // Concatenation alone produced one. With a mailbox literally named "/", renaming "" to "z" gave
  // "z/", which canonicalises back to "z" — so the catalog held two rows resolving to one mailbox:
  // STATUS on one answered about the other, DELETE on one removed the other, and the survivor was
  // listed but unselectable. Both stores share this helper, so the differential oracle that
  // compares them cannot see a defect here; the rule has to be right where it lives.
  const moves = subtreeRenames('', 'z', ['/']);
  assert.notEqual(moves, null);
  for (const [, dest] of moves!) {
    assert.equal(dest, canonicalMailboxName(dest), `${dest} is already canonical`);
  }
});

test('a rename whose destinations collide after canonicalisation is refused, not silently merged', () => {
  // "" and "/" both canonicalise onto "z". Reported as a collision so the callers can answer the
  // protocol's existing 'exists', which is what RFC 9051 §6.3.5 asks for.
  assert.equal(subtreeRenames('', 'z', ['', '/']), null);
});

test('a subtree rename whose synthesized child name exceeds the bounds is refused', () => {
  // CREATE and the RENAME target both enforce the name bounds; the subtree children the rename
  // synthesizes did not. Renaming a parent to a name AT the octet cap pushes `to + "/child"` past it,
  // and the over-cap name would be stored and paid for on every LIST.
  const atOctetCap = 'x'.repeat(MAX_MAILBOX_NAME_OCTETS); // the target itself is within bounds
  assert.equal(subtreeRenames('A', atOctetCap, ['A', 'A/b']), null, 'a child pushed over the octet cap refuses the rename');
  // The same for the segment cap: a target at the segment limit plus a child adds one more segment.
  const atSegmentCap = Array.from({ length: MAX_MAILBOX_SEGMENTS }, (_, i) => `s${i}`).join('/');
  assert.equal(subtreeRenames('A', atSegmentCap, ['A', 'A/b']), null, 'a child pushed over the segment cap refuses the rename');
  // Control: renaming the same subtree to a short name is fine, and moves both rows.
  assert.equal(subtreeRenames('A', 'Z', ['A', 'A/b'])?.length, 2, 'a within-bounds subtree rename still maps every child');
});
