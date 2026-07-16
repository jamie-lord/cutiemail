/**
 * RFC 9051 (IMAP4rev2) §2.3.1.1 — Unique Identifier (UID) semantics
 *
 * The storage-layer invariants behind the read leg. UIDs are the stable handle a
 * client uses to resynchronize across sessions, so their assignment rules are
 * load-bearing: strictly ascending, never reused (with UIDVALIDITY as the escape
 * hatch), and UIDNEXT advancing on every add even if the message is later expunged.
 * These are testable as a reference mailbox model — no live server — so the storage
 * semantics can be pinned before the SQLite backing is built.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_MAILBOX_STATE = [
  {
    id: 'R-9051-2.3.1.1-a',
    rfc: 'rfc9051',
    section: '2.3.1.1',
    page: 14,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'as each message is added to the mailbox, it is assigned a higher UID than those of all message(s) that are already in the mailbox.',
    testability: { kind: 'parse' },
    note:
      'Strictly ascending UID assignment: every appended message gets a UID higher ' +
      'than any already present. Our reference Mailbox assigns from a monotonic ' +
      'counter; the nonAscendingUid defect (reuse the current value) is the negative ' +
      'control. A non-ascending UID breaks a client\'s ability to reason about ' +
      '"messages since UID N".',
  },
  {
    id: 'R-9051-2.3.1.1-b',
    rfc: 'rfc9051',
    section: '2.3.1.1',
    page: 14,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'the next unique identifier value MUST change whenever new messages are added to the mailbox, even if those new messages are subsequently expunged.',
    testability: { kind: 'parse' },
    note:
      'UIDNEXT advances on every add and never rolls back — so a UID is never reused, ' +
      'even after the message that consumed it is expunged. Our Mailbox never lowers ' +
      'uidNext; the reuseExpungedUid defect (roll it back on expunge) is the negative ' +
      'control. Reusing an expunged UID would let a client confuse a new message for ' +
      'an old one it had cached.',
  },
] as const satisfies readonly RequirementDef[];
