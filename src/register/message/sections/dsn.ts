/**
 * RFC 3464 — Delivery Status Notifications (the message/delivery-status body)
 *
 * When the queue gives up or hits a permanent failure, it bounces — and the bounce
 * is a DSN: a multipart/report whose machine-readable part is a
 * message/delivery-status body of per-recipient groups. The required fields
 * (Final-Recipient, Action) are what let the original sender's MUA understand which
 * recipient failed and why, so a DSN missing them is useless. This section covers
 * the per-recipient required fields; generating it connects the queue (bounce) to
 * the message layer.
 *
 * Verbatim quotes from spec/rfc3464.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DSN = [
  {
    id: 'R-3464-2.3.2-a',
    rfc: 'rfc3464',
    section: '2.3.2',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'This field MUST be present in each set of per-recipient data.',
    testability: { kind: 'parse' },
    note:
      'The Final-Recipient field names the recipient a per-recipient group is about, ' +
      'and must appear in every group. Our generator emits it for each recipient and ' +
      'our validator rejects a group without it; the omitFinalRecipient defect is the ' +
      'negative control.',
  },
  {
    id: 'R-3464-2.3.3-a',
    rfc: 'rfc3464',
    section: '2.3.3',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'This field MUST be present for each recipient named in the DSN.',
    testability: { kind: 'parse' },
    note:
      'The Action field (failed / delayed / delivered / relayed / expanded) states ' +
      'what happened to each recipient, and must be present and be one of those ' +
      'values. Our validator rejects a missing or unknown Action; the omitAction and ' +
      'invalidAction defects are the negative controls.',
  },
] as const satisfies readonly RequirementDef[];
