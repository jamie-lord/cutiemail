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
  {
    id: 'R-9051-2.3.2-a',
    rfc: 'rfc9051',
    section: '2.3.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'A flag is set by its addition to this list and is cleared by its removal.',
    testability: { kind: 'parse' },
    note:
      'STORE semantics: +FLAGS adds, -FLAGS removes, FLAGS replaces. Our mailbox ' +
      'storeFlags applies these; the removeDoesntClear defect (a no-op removal) is ' +
      'the negative control. Flags are a set — adding a present flag is idempotent.',
  },
  {
    id: 'R-9051-2.3.2-b',
    rfc: 'rfc9051',
    section: '2.3.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Message is "deleted" for removal by later EXPUNGE',
    testability: { kind: 'parse' },
    note:
      'The \\Deleted flag marks a message for removal; EXPUNGE then removes exactly ' +
      'the \\Deleted-flagged messages (not others). Our expungeDeleted removes them; ' +
      'the expungeIgnoresDeleted defect (leave them) is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
