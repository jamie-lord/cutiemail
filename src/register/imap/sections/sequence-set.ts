/**
 * RFC 9051 (IMAP4rev2) §9 — sequence-set ("*" semantics)
 *
 * The message-set syntax FETCH/STORE/COPY/SEARCH all take: "1:5,7,10:*". The one
 * parse rule with real teeth is "*" — it means the largest number in use, not a
 * literal. A parser that mishandles it addresses the wrong messages. (The range
 * order-independence rule lives with the UID semantics, R-9051-2.3.1.1-d.)
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_SEQUENCE_SET = [
  {
    id: 'R-9051-9-a',
    rfc: 'rfc9051',
    section: '9',
    page: 89,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: '* represents the largest number in use.',
    testability: { kind: 'parse' },
    note:
      'In a sequence-set, "*" resolves to the largest message number (or UID) in the ' +
      'mailbox, not a literal. Our parser substitutes the mailbox\'s largest; the ' +
      'starIsLiteralOne defect (treat "*" as 1) is the negative control — it would ' +
      'address the first message instead of the last.',
  },
] as const satisfies readonly RequirementDef[];
