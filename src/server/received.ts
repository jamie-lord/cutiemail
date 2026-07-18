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
 * Extract and normalise the authserv-id from an unfolded Authentication-Results value
 * per RFC 8601 §2.2: the id is `value = token / quoted-string`, optionally surrounded by
 * RFC 5322 CFWS (comments). A naive "first non-space/`;` token" match is evadable — a
 * forgery can write our id as `(comment) us.example` or `"us.example"`, which a compliant
 * consumer resolves back to `us.example` while the naive match sees the comment/quotes and
 * keeps the header. Normalise before comparing: strip comments (any nesting), unwrap a
 * quoted-string, drop a trailing FQDN dot, lowercase. Returns null if none is found.
 */
export function authservIdOf(unfoldedHeader: string): string | null {
  const m = /^Authentication-Results:(.*)$/is.exec(unfoldedHeader);
  if (m === null) return null;
  // Remove RFC 5322 comments, innermost first, until none remain (handles nesting).
  let v = m[1]!;
  let prev: string;
  do {
    prev = v;
    v = v.replace(/\([^()]*\)/g, ' ');
  } while (v !== prev);
  v = v.replace(/^[ \t]+/, '');
  let id: string;
  if (v.startsWith('"')) {
    // quoted-string: read to the closing unescaped quote.
    let out = '';
    let k = 1;
    for (; k < v.length; k++) {
      const ch = v[k]!;
      if (ch === '\\' && k + 1 < v.length) {
        out += v[++k];
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    id = out;
  } else {
    // token: terminated by CFWS, the authres-version, or the first `;`.
    id = v.split(/[;\s]/)[0] ?? '';
  }
  if (id === '') return null;
  return id.replace(/\.$/, '').toLowerCase();
}

/**
 * Remove any Authentication-Results header bearing OUR authserv-id (RFC 8601 §5). An
 * attacker can put a forged "Authentication-Results: <us>; dkim=pass ..." in the message
 * they send; if we leave it, a client cannot tell it from the one we add and may trust
 * the forgery. We strip those (matching the RFC 8601 authserv-id, normalised for CFWS
 * comments and quoted-string forms) before stamping our own. Other authserv-ids (a
 * legitimate upstream) are left intact. Other headers are preserved byte-for-byte.
 */
export function stripOwnAuthResults(data: Buffer, authservId: string): Buffer {
  const sep = data.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  // A message with no blank line is all headers (a malformed body-less message); still
  // strip a forged AR from it rather than passing the whole thing through unfiltered.
  const headerEnd = sep === -1 ? data.length : sep;
  const trailer = sep === -1 ? Buffer.alloc(0) : data.subarray(sep);
  const lines = data.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const kept: string[] = [];
  const want = authservId.replace(/\.$/, '').toLowerCase(); // normalise to match authservIdOf
  for (let i = 0; i < lines.length; ) {
    let header = lines[i]!;
    let j = i + 1;
    while (j < lines.length && /^[ \t]/.test(lines[j]!)) header += `\r\n${lines[j++]}`; // gather folded continuations
    // Match the authserv-id on the UNFOLDED header: RFC 5322 CFWS lets the id wrap onto
    // a continuation line, and a forgery that folds it would otherwise slip past.
    const unfolded = header.replace(/\r\n[ \t]+/g, ' ');
    const id = authservIdOf(unfolded);
    if (id !== want) kept.push(header);
    i = j;
  }
  return Buffer.concat([Buffer.from(kept.join('\r\n'), 'latin1'), trailer]);
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
