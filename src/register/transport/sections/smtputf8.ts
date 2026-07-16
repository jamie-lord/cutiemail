/**
 * RFC 6531 — SMTPUTF8 (internationalized email transmission gate)
 *
 * The modern-server vision includes internationalized addresses (用户@例え.jp). But
 * a client MUST NOT push internationalized content at a server that hasn't offered
 * SMTPUTF8 — doing so corrupts the envelope on a legacy hop. The parse-testable rule
 * is that gate: detect whether content is internationalized (any non-ASCII octet)
 * and refuse to transmit it unless SMTPUTF8 was negotiated.
 *
 * Verbatim quotes from spec/rfc6531.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SMTPUTF8 = [
  {
    id: 'R-6531-3.5-a',
    rfc: 'rfc6531',
    section: '3.5',
    page: 10,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'An SMTPUTF8-aware SMTP client MUST NOT send an internationalized message to an SMTP server that does not support SMTPUTF8.',
    testability: { kind: 'parse' },
    note:
      'The negotiation gate: an internationalized message (a non-ASCII address or ' +
      'internationalized header) may only be transmitted to a server that advertised ' +
      'SMTPUTF8. Our mayTransmit refuses otherwise; the sendWithoutNegotiation defect ' +
      'is the negative control. An all-ASCII message is unaffected — it transmits to ' +
      'any server.',
  },
] as const satisfies readonly RequirementDef[];
