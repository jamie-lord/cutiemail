/**
 * RFC 9051 (IMAP4rev2) §7.5.2 — FETCH ENVELOPE
 *
 * The ENVELOPE is the structured view of a message's key headers that a client
 * FETCHes instead of parsing the raw message itself. It connects the message parser
 * to IMAP output: the server parses From/To/Subject/Date/... and emits them in a
 * fixed structure. Two rules a formatter must hold: the exact field order, and the
 * Sender/Reply-To defaulting to From when absent (so a client need not know to do
 * it). Getting either wrong makes a client mis-display the message.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_ENVELOPE = [
  {
    id: 'R-9051-7.5.2-a',
    rfc: 'rfc9051',
    section: '7.5.2',
    page: 82,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The fields of the envelope structure are in the following order: date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to, and message-id.',
    testability: { kind: 'parse' },
    note:
      'The ENVELOPE is a fixed-order tuple; a client reads it positionally, so the ' +
      'order is load-bearing. Our formatter emits exactly this order; the ' +
      'wrongFieldOrder defect (swap two fields) is the negative control.',
  },
  {
    id: 'R-9051-7.5.2-b',
    rfc: 'rfc9051',
    section: '7.5.2',
    page: 82,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'If the Sender or Reply-To header fields are absent in the [RFC5322] header, or are present but empty, the server sets the corresponding member of the envelope to be the same value as the from member',
    testability: { kind: 'parse' },
    note:
      'Sender and Reply-To default to From when absent/empty — the server does it so ' +
      'the client need not. Our formatter fills them from From; the nilAbsentSender ' +
      'defect (leave them NIL) is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
