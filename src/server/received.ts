/**
 * The Received: trace header (RFC 5321 §4.4).
 *
 * Every MTA that accepts a message for delivery or relay MUST prepend a Received
 * line to the top of the message. It's the audit trail of the path a message
 * took, and it's load-bearing for two real things: receivers (Gmail) read the
 * Received chain as a trust/deliverability signal, and counting Received lines is
 * how mail loops are detected and broken. We add one both when storing inbound
 * mail (we're the final-delivery MTA) and when relaying outbound (we're the
 * first-hop MTA), never on the mailbox itself — the store keeps exactly the bytes
 * it is handed; the RECEIVER is what stamps the trace.
 *
 * The `protocol` follows the "with" registry: ESMTP (plaintext), ESMTPS
 * (TLS, no auth), ESMTPSA (TLS + authenticated submission) — RFC 3848.
 */

import { formatDate } from './submission-fixup.ts';

export interface ReceivedInfo {
  /** The name the client announced in EHLO/HELO. */
  readonly helo: string;
  /** The client's IP address (empty string if unknown). */
  readonly remoteAddress: string;
  /** Our own hostname (the "by" clause). */
  readonly by: string;
  readonly protocol: 'ESMTP' | 'ESMTPS' | 'ESMTPSA';
  /** A unique per-hop id. */
  readonly id: string;
  /** The single envelope recipient, when known (the "for" clause). */
  readonly forRecipient?: string;
  readonly date: Date;
}

/** Select the "with" protocol token from the connection's TLS/auth state. */
export function protocolFor(overTls: boolean, authenticated: boolean): ReceivedInfo['protocol'] {
  if (authenticated) return 'ESMTPSA';
  return overTls ? 'ESMTPS' : 'ESMTP';
}

/** Build the Received header line (no trailing CRLF). */
export function receivedHeader(info: ReceivedInfo): string {
  const from = info.remoteAddress !== '' ? `from ${info.helo || '[unknown]'} ([${info.remoteAddress}])` : `from ${info.helo || '[unknown]'}`;
  const forClause = info.forRecipient !== undefined ? ` for <${info.forRecipient}>` : '';
  return `Received: ${from} by ${info.by} with ${info.protocol} id ${info.id}${forClause}; ${formatDate(info.date)}`;
}

/** Prepend a Received trace line to a message's headers. */
export function prependReceived(data: Buffer, info: ReceivedInfo): Buffer {
  return Buffer.concat([Buffer.from(`${receivedHeader(info)}\r\n`, 'latin1'), data]);
}
