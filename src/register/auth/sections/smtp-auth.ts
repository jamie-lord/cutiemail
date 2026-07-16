/**
 * RFC 4954 — SMTP AUTH (command sequencing)
 *
 * The SMTP-side binding of SASL (the SCRAM crypto lives in RFC 5802). The
 * testable, state-machine rules are AUTH sequencing: AUTH is not allowed during a
 * mail transaction, and not allowed twice in a session. Layered on top is the
 * opinionated ADR-0007 rule — no plaintext AUTH without TLS — which the same state
 * machine enforces. Getting sequencing wrong opens auth-state confusion.
 *
 * Verbatim quotes from spec/rfc4954.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SMTP_AUTH = [
  {
    id: 'R-4954-4-a',
    rfc: 'rfc4954',
    section: '4',
    page: 4,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'An AUTH command issued during a mail transaction MUST be rejected with a 503 reply.',
    testability: { kind: 'parse' },
    note:
      'AUTH may not interleave with a transaction: once MAIL FROM has opened one, an ' +
      'AUTH gets 503. Our submission state machine rejects it; the ' +
      'allowAuthInTransaction defect is the negative control.',
  },
  {
    id: 'R-4954-4-b',
    rfc: 'rfc4954',
    section: '4',
    page: 4,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'After a successful AUTH command completes, a server MUST reject any further AUTH commands with a 503 reply.',
    testability: { kind: 'parse' },
    note:
      'No re-authentication in one session: a second AUTH after a successful one gets ' +
      '503. Our state machine rejects it; the allowReauth defect is the negative ' +
      'control. This entry also anchors the ADR-0007 no-plaintext-AUTH-without-TLS ' +
      'gate (tested on the same machine).',
  },
] as const satisfies readonly RequirementDef[];
