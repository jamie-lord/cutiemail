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

/**
 * Remove any Authentication-Results header bearing OUR authserv-id (RFC 8601 §5). An
 * attacker can put a forged "Authentication-Results: <us>; dkim=pass ..." in the message
 * they send; if we leave it, a client cannot tell it from the one we add and may trust
 * the forgery. We strip those (matching the authserv-id, the first token of the value)
 * before stamping our own. Other authserv-ids (a legitimate upstream) are left intact.
 * Other headers are preserved byte-for-byte, including their folding.
 */
export function stripOwnAuthResults(data: Buffer, authservId: string): Buffer {
  const sep = data.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  if (sep === -1) return data;
  const lines = data.subarray(0, sep).toString('latin1').split('\r\n');
  const kept: string[] = [];
  const want = authservId.toLowerCase();
  for (let i = 0; i < lines.length; ) {
    let header = lines[i]!;
    let j = i + 1;
    while (j < lines.length && /^[ \t]/.test(lines[j]!)) header += `\r\n${lines[j++]}`; // gather folded continuations
    const m = /^Authentication-Results:[ \t]*([^;\s]+)/i.exec(header);
    if (!(m !== null && m[1]!.toLowerCase() === want)) kept.push(header);
    i = j;
  }
  return Buffer.concat([Buffer.from(kept.join('\r\n'), 'latin1'), data.subarray(sep)]);
}

/**
 * Count the Received: header fields in a message (RFC 5321 §6.3 loop detection).
 * Only field starts count — continuation (folded) lines begin with whitespace and
 * are skipped. Counting the trace hops is how a mail loop is caught and broken.
 */
export function countReceived(data: Buffer): number {
  const sep = data.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  const headerBlock = (sep === -1 ? data : data.subarray(0, sep)).toString('latin1');
  let count = 0;
  for (const line of headerBlock.split('\r\n')) {
    if (/^received:/i.test(line)) count += 1;
  }
  return count;
}
