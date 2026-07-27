/**
 * Submission fix-up (RFC 6409 §8.1/§8.2): an MSA MAY add a Date and Message-ID
 * to a submitted message that lacks them.
 *
 * Real MUAs (Thunderbird, Gmail) always supply both, but large receivers now
 * enforce their presence — Gmail hard-rejects with "550 5.7.1 Messages missing
 * a valid Message-ID header are not accepted" — so a minimal client's message
 * would be accepted by our submission port and then bounce off every real MX.
 * Fixing up at submission (never on the inbound/relay port — a relay must not
 * alter the message, §4.4 trace excepted) keeps outbound deliverable.
 *
 * Bytes, never strings: the message is untouched unless a header is missing,
 * in which case the new header lines are prepended as latin1 octets — the same
 * top-of-message position the Received: trace line uses. A message that already
 * has both headers is returned as the SAME Buffer, byte-identical.
 */

import { randomBytes } from 'node:crypto';
import { parseMessage, hasHeader } from '../message/parse.ts';

export interface FixupClock {
  /** Injected for deterministic tests; defaults to the real clock. */
  readonly now?: () => Date;
  /** Injected for deterministic tests; defaults to random hex. */
  readonly unique?: () => string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** RFC 5322 §3.3 date-time, always rendered in UTC (+0000). */
export function formatDate(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]!}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]!} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`
  );
}

/**
 * Return `data` with the From, Date and Message-ID headers guaranteed present
 * (`sender` is the envelope MAIL FROM, used for a missing From). RFC 5322 requires
 * From and receivers reject messages lacking Date/Message-ID; a From is also what our
 * DKIM signature must cover (§5.4), so a From-less submission would otherwise be signed
 * meaninglessly. Untouched (same Buffer) when all three already exist.
 *
 * Returns `null` when the header section is too large to parse completely — the caller must
 * refuse the message. Every decision here is a NEGATIVE claim ("this message has no From"),
 * and a truncated parse cannot support one: the client's real From may simply sit past the
 * cap. Synthesizing an owned From over a hidden one would hand the send-as gate a single owned
 * address to approve and ship the message DKIM-signed with two From headers, ours above the
 * sender's. The guard lives here rather than at the call site so it cannot be forgotten by a
 * second caller, and because the parse it needs has already been done.
 */
export function ensureSubmissionHeaders(data: Buffer, domain: string, sender: string, clock: FixupClock = {}): Buffer | null {
  const msg = parseMessage(data);
  if (msg.headersTruncated) return null;
  const needFrom = !hasHeader(msg, 'From') && sender !== '';
  const needDate = !hasHeader(msg, 'Date');
  const needId = !hasHeader(msg, 'Message-ID');
  if (!needFrom && !needDate && !needId) return data;

  const now = clock.now?.() ?? new Date();
  const unique = clock.unique?.() ?? randomBytes(9).toString('hex');
  const added: string[] = [];
  if (needId) added.push(`Message-ID: <${now.getTime()}.${unique}@${domain}>\r\n`);
  if (needDate) added.push(`Date: ${formatDate(now)}\r\n`);
  if (needFrom) added.push(`From: <${sender}>\r\n`);
  const out = Buffer.concat([Buffer.from(added.join(''), 'latin1'), data]);
  // CHECKED AGAIN, ON WHAT WE RETURN. The check above was on the input, and what leaves here is
  // LARGER — so a message whose header section sat just under the cap can be pushed over it by the
  // very headers this function adds. The caller re-parses this buffer to decide which From it is
  // authorising, and that parse then drops the fields past the cap: the send-as gate approved a
  // message with one From while the bytes it approved carried two. Re-parsing costs one pass on the
  // fix-up path only, and it belongs here rather than at the call site for the reason above — a
  // second caller cannot forget what this function does not let it see.
  return parseMessage(out).headersTruncated ? null : out;
}
