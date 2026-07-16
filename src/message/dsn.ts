/**
 * DSN message/delivery-status generation and validation (RFC 3464 §2.3), with
 * switchable defects.
 *
 * Produces the machine-readable body of a bounce — a per-message group
 * (Reporting-MTA) followed by one per-recipient group (Final-Recipient, Action,
 * Status) per recipient — and validates that a body carries the required fields.
 * This is what the queue emits when it bounces (src/store/queue.ts). The enclosing
 * multipart/report wrapper and the returned original message are a later increment.
 *
 * Bytes, never strings: the body is assembled as CRLF-delimited field lines.
 */

export type DsnAction = 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded';

const VALID_ACTIONS: readonly string[] = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'];

export interface RecipientStatus {
  readonly recipient: string;
  readonly action: DsnAction;
  /** RFC 3463 status code, e.g. "5.1.1". */
  readonly status: string;
}

export interface DsnDefects {
  /** Omit the Final-Recipient field. Violates R-3464-2.3.2-a. */
  readonly omitFinalRecipient?: boolean;
  /** Omit the Action field. Violates R-3464-2.3.3-a. */
  readonly omitAction?: boolean;
  /** Emit an Action value outside the defined set. Violates R-3464-2.3.3-a. */
  readonly invalidAction?: boolean;
}

const CRLF = '\r\n';

/** Generate a message/delivery-status body. */
export function generateDeliveryStatus(reportingMta: string, recipients: readonly RecipientStatus[], defects: DsnDefects = {}): Buffer {
  const groups: string[] = [`Reporting-MTA: dns; ${reportingMta}`];
  for (const r of recipients) {
    const lines: string[] = [];
    if (defects.omitFinalRecipient !== true) lines.push(`Final-Recipient: rfc822; ${r.recipient}`);
    if (defects.omitAction !== true) lines.push(`Action: ${defects.invalidAction === true ? 'exploded' : r.action}`);
    lines.push(`Status: ${r.status}`);
    groups.push(lines.join(CRLF));
  }
  return Buffer.from(groups.join(CRLF + CRLF) + CRLF, 'latin1');
}

export interface DsnValidation {
  readonly valid: boolean;
  readonly anomalies: readonly string[];
}

/** Validate that every per-recipient group has a Final-Recipient and a valid Action. */
export function validateDeliveryStatus(body: Buffer): DsnValidation {
  const text = body.toString('latin1');
  // Groups are separated by a blank line; the first group is per-message.
  const groups = text.split(/\r?\n\r?\n/).map((g) => g.trim()).filter((g) => g.length > 0);
  const anomalies: string[] = [];

  const perRecipient = groups.slice(1); // drop the per-message (Reporting-MTA) group
  if (perRecipient.length === 0) anomalies.push('no-recipient-groups');

  for (const [i, group] of perRecipient.entries()) {
    const fields = new Map<string, string>();
    for (const line of group.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    if (!fields.has('final-recipient')) anomalies.push(`missing-final-recipient:${i}`);
    const action = fields.get('action');
    if (action === undefined) anomalies.push(`missing-action:${i}`);
    else if (!VALID_ACTIONS.includes(action.toLowerCase())) anomalies.push(`invalid-action:${i}:${action}`);
  }

  return { valid: anomalies.length === 0, anomalies };
}
