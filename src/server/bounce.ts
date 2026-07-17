/**
 * Non-delivery report (bounce) assembly — RFC 3461/3462/3464.
 *
 * When the relay gives up on a message, RFC 5321 §6.1 requires notifying the sender.
 * This wraps the machine-readable message/delivery-status body (src/message/dsn.ts,
 * generateDeliveryStatus) in the multipart/report structure a bounce actually is: a
 * human-readable explanation, the delivery-status body, and the returned original
 * message. dsn.ts left "the enclosing multipart/report wrapper and the returned
 * original message" for later — this is that.
 *
 * The bounce's envelope return-path MUST be null (<>) so it can never itself bounce
 * (§6.1) — the caller enforces that; here we only build the message bytes.
 */

import { generateDeliveryStatus, type RecipientStatus } from '../message/dsn.ts';

export interface BounceInput {
  /** Our hostname, for the Reporting-MTA and From. */
  readonly reportingMta: string;
  /** The original message's envelope sender — the bounce's recipient. */
  readonly originalSender: string;
  /** The original message bytes, returned in the report. */
  readonly originalData: Buffer;
  /** Per-recipient failure detail. */
  readonly failures: readonly (RecipientStatus & { readonly detail: string })[];
  /** The date to stamp (injected so this stays pure/testable). */
  readonly date: string;
  /** A unique boundary + Message-ID token (injected — no Date.now/random here). */
  readonly token: string;
}

/**
 * Build a complete multipart/report bounce message (headers + body). The caller
 * delivers it to `originalSender` with a null envelope return-path.
 */
export function buildBounceMessage(input: BounceInput): Buffer {
  const boundary = `=_bounce_${input.token}`;
  const status = generateDeliveryStatus(input.reportingMta, input.failures);

  const humanLines = [
    `This is the mail system at host ${input.reportingMta}.`,
    '',
    'I am sorry to inform you that your message could not be delivered',
    'to one or more recipients. It is attached below.',
    '',
    ...input.failures.map((f) => `<${f.recipient}>: ${f.detail}`),
    '',
  ];
  const human = Buffer.from(humanLines.join('\r\n') + '\r\n', 'latin1');

  const headers =
    `From: Mail Delivery System <MAILER-DAEMON@${input.reportingMta}>\r\n` +
    `To: <${input.originalSender}>\r\n` +
    `Subject: Undelivered Mail Returned to Sender\r\n` +
    `Date: ${input.date}\r\n` +
    `Message-ID: <bounce-${input.token}@${input.reportingMta}>\r\n` +
    `Auto-Submitted: auto-replied\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"\r\n` +
    `\r\n`;

  const parts =
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=us-ascii\r\n\r\n` +
    human.toString('latin1') +
    `\r\n--${boundary}\r\n` +
    `Content-Type: message/delivery-status\r\n\r\n` +
    status.toString('latin1') +
    `\r\n--${boundary}\r\n` +
    `Content-Type: message/rfc822\r\n\r\n` +
    input.originalData.toString('latin1') +
    `\r\n--${boundary}--\r\n`;

  return Buffer.from(headers + parts, 'latin1');
}
