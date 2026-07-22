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
  /**
   * The remote MX's verbatim reply, emitted as a sanitized Diagnostic-Code (RFC 3464 §2.3.6,
   * SHOULD). Sanitized before it reaches the field: the reply is attacker-influenced bytes, and
   * CR/LF in it would otherwise inject extra DSN fields or groups (header-injection into the
   * bounce). Omitted when absent.
   */
  readonly diagnostic?: string;
  /** The remote MTA we last spoke to, emitted as Remote-MTA (RFC 3464 §2.3.5). Omitted when absent. */
  readonly remoteMta?: string;
}

export interface DsnDefects {
  /** Omit the Final-Recipient field. Violates R-3464-2.3.2-a. */
  readonly omitFinalRecipient?: boolean;
  /** Omit the Action field. Violates R-3464-2.3.3-a. */
  readonly omitAction?: boolean;
  /** Emit an Action value outside the defined set. Violates R-3464-2.3.3-a. */
  readonly invalidAction?: boolean;
  /** Emit a Diagnostic-Code with no "diagnostic-type;" prefix (RFC 3464 §2.3.6). */
  readonly diagnosticWithoutType?: boolean;
  /** Skip sanitizing the diagnostic text - the CR/LF-injection negative control. */
  readonly skipDiagnosticSanitize?: boolean;
}

const CRLF = '\r\n';

/**
 * One-line, safe field value for a remote-derived string. Strips CR/LF and other control
 * octets (collapsed to a space) and caps the length, so a hostile remote reply cannot inject
 * new header/field lines into the DSN or run on unbounded.
 */
function sanitizeDiagnostic(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 256);
}

/** Generate a message/delivery-status body. */
export function generateDeliveryStatus(reportingMta: string, recipients: readonly RecipientStatus[], defects: DsnDefects = {}): Buffer {
  const groups: string[] = [`Reporting-MTA: dns; ${reportingMta}`];
  for (const r of recipients) {
    const lines: string[] = [];
    if (defects.omitFinalRecipient !== true) lines.push(`Final-Recipient: rfc822; ${r.recipient}`);
    if (defects.omitAction !== true) lines.push(`Action: ${defects.invalidAction === true ? 'exploded' : r.action}`);
    lines.push(`Status: ${r.status}`);
    // Remote-MTA (§2.3.5) and Diagnostic-Code (§2.3.6) are SHOULDs that tell the sender WHICH
    // server rejected the mail and WHY - the difference between an actionable bounce and a
    // useless one. Both carry a "type;" prefix, and the diagnostic is sanitized (see above).
    if (r.remoteMta !== undefined && r.remoteMta.length > 0) lines.push(`Remote-MTA: dns; ${sanitizeDiagnostic(r.remoteMta)}`);
    if (r.diagnostic !== undefined && r.diagnostic.length > 0) {
      const value = defects.skipDiagnosticSanitize === true ? r.diagnostic : sanitizeDiagnostic(r.diagnostic);
      lines.push(defects.diagnosticWithoutType === true ? `Diagnostic-Code: ${value}` : `Diagnostic-Code: smtp; ${value}`);
    }
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
    // A present Diagnostic-Code (§2.3.6) must be a "diagnostic-type; text" pair, and - the
    // security-relevant part - a single line. Because groups are split on blank lines and fields
    // on line breaks, an unsanitized CR/LF in the remote reply would have surfaced here as a
    // stray extra field or group; this check is the detector for that injection.
    const diag = fields.get('diagnostic-code');
    if (diag !== undefined && !/^\S+\s*;/.test(diag)) anomalies.push(`malformed-diagnostic-code:${i}`);
    const remoteMta = fields.get('remote-mta');
    if (remoteMta !== undefined && !/^\S+\s*;/.test(remoteMta)) anomalies.push(`malformed-remote-mta:${i}`);
  }

  return { valid: anomalies.length === 0, anomalies };
}
