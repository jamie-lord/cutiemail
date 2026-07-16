/**
 * RFC 9051 (IMAP4rev2) §6.4.4 — SEARCH (multiple-key AND semantics)
 *
 * SEARCH matches messages against one or more search keys. The rule that shapes
 * every query: multiple keys are ANDed — a message matches only if it satisfies ALL
 * of them. A server that ORs them instead returns far too many messages, silently
 * defeating the client's filter.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_SEARCH = [
  {
    id: 'R-9051-6.4.4-a',
    rfc: 'rfc9051',
    section: '6.4.4',
    page: 41,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'When multiple keys are specified, the result is the intersection (AND function) of all the messages that match those keys.',
    testability: { kind: 'parse' },
    note:
      'Multiple search keys are ANDed: a message matches only if every key matches. ' +
      'Our evaluator requires all keys; the orSemantics defect (match if ANY key ' +
      'matches) is the negative control — it would return messages the client\'s ' +
      'filter should have excluded.',
  },
] as const satisfies readonly RequirementDef[];
