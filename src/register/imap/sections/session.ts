/**
 * RFC 9051 (IMAP4rev2) §6.3.3 — EXAMINE (read-only selected state)
 *
 * A mailbox opened with EXAMINE (rather than SELECT) is read-only: the client can
 * read but MUST NOT be able to change anything. This is a session-level property —
 * another session may have the same mailbox open read-write — so it is modelled as
 * a session wrapper over the mailbox. A mutation slipping through a read-only
 * session is a real data-integrity bug.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_SESSION = [
  {
    id: 'R-9051-6.3.3-a',
    rfc: 'rfc9051',
    section: '6.3.3',
    page: 47,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'No changes to the permanent state of the mailbox, including per-user state, are permitted.',
    testability: { kind: 'parse' },
    note:
      'A read-only (EXAMINE-opened) session must refuse every mutation — STORE flags, ' +
      'EXPUNGE, APPEND — leaving the mailbox unchanged, while reads still work. Our ' +
      'MailboxSession gates writes on the read-only flag; the allowWriteWhenReadOnly ' +
      'defect (let a write through) is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
