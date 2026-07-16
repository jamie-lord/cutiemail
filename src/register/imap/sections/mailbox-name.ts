/**
 * RFC 9051 (IMAP4rev2) §5.1 — Mailbox Naming (the INBOX special case)
 *
 * "INBOX" is the one mailbox name that is case-insensitive: "inbox", "InBoX" and
 * "INBOX" all mean the user's primary mailbox. Every other name is case-sensitive.
 * A server that gets this wrong either hides the user's mail (treats "inbox" as a
 * new mailbox) or collapses distinct mailboxes.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_MAILBOX_NAME = [
  {
    id: 'R-9051-5.1-a',
    rfc: 'rfc9051',
    section: '5.1',
    page: 21,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The case-insensitive mailbox name INBOX is a special name reserved to mean "the primary mailbox for this user on this server".',
    testability: { kind: 'parse' },
    note:
      'INBOX matches case-insensitively; all other mailbox names are case-sensitive. ' +
      'Our resolver canonicalises any-case INBOX to "INBOX" and leaves other names ' +
      'untouched; the caseSensitiveInbox defect (treat "inbox" as distinct from ' +
      '"INBOX") is the negative control — it would strand the user\'s primary mailbox.',
  },
] as const satisfies readonly RequirementDef[];
