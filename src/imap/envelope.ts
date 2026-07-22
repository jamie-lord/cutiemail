/**
 * IMAP FETCH ENVELOPE construction (RFC 9051 §7.5.2), with switchable defects.
 *
 * Turns a message's parsed headers into the fixed-order ENVELOPE structure a client
 * FETCHes. The field order is load-bearing (clients read it positionally) and
 * Sender/Reply-To default to From when absent. This connects the message parser to
 * IMAP output; the raw-message-to-headers parsing is src/message/parse.ts.
 */

import type { Header } from '../message/model.ts';

/**
 * One entry in an ENVELOPE address list: (name adl mailbox host). adl is unused (NIL).
 *
 * RFC 9051 §7.5.2 also carries RFC 5322 group syntax as special forms of this same
 * structure, distinguished by a NIL host:
 *   - a group START marker has host === '' (serialized NIL) and mailbox === the group
 *     name phrase (non-NIL);
 *   - a group END marker has host === null AND mailbox === null (both NIL).
 * So `mailbox` is nullable purely to express the end marker (NIL NIL NIL NIL).
 */
export interface EnvelopeAddress {
  readonly name: string | null;
  readonly mailbox: string | null;
  readonly host: string | null;
}

/** ENVELOPE field value: a string (date/subject/ids), an address list, or NIL (null). */
export type EnvelopeValue = string | readonly EnvelopeAddress[] | null;

export interface Envelope {
  /** The ten fields in RFC 9051 §7.5.2 order. */
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: EnvelopeValue }>;
}

export interface EnvelopeDefects {
  /** Emit the fields in the wrong order. Violates R-9051-7.5.2-a. */
  readonly wrongFieldOrder?: boolean;
  /** Leave an absent Sender/Reply-To as NIL instead of defaulting to From. Violates R-9051-7.5.2-b. */
  readonly nilAbsentSender?: boolean;
  /**
   * Do not emit RFC 9051 §7.5.2 group start/end markers: treat the group name and its
   * ':'/';' delimiters as ordinary address text. Reproduces the pre-fix corruption where
   * the group name glues onto the first mailbox and the trailing ';' leaks into the last
   * host. Negative control for the group-marker behaviour.
   */
  readonly noGroupMarkers?: boolean;
}

/**
 * Unfold a header value (RFC 5322 §2.2.3): a folded header wraps across lines, each
 * continuation starting with WSP, and unfolding removes the CRLF that precedes the
 * WSP. This MUST happen before the value goes into an ENVELOPE — an IMAP quoted
 * string cannot contain CR or LF, so emitting a folded Subject verbatim produces a
 * malformed response that desyncs the client's parser. Any stray bare CR/LF is
 * collapsed to a space as a belt-and-braces guard.
 */
function unfold(value: string): string {
  return value.replace(/\r\n(?=[ \t])/g, '').replace(/[\r\n]+/g, ' ');
}

/** Case-insensitive first header value (unfolded), or null. */
function headerValue(headers: readonly Header[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower) return unfold(h.value.toString('latin1')).trim();
  }
  return null;
}

/** Group markers (RFC 9051 §7.5.2): both use a NIL host to signal group syntax. */
const groupStart = (name: string): EnvelopeAddress => ({ name: null, mailbox: name, host: '' });
const groupEnd = (): EnvelopeAddress => ({ name: null, mailbox: null, host: null });

/**
 * Parse an address list header value into ENVELOPE address structures.
 *
 * Handles RFC 5322 §3.4 group syntax (`display-name ":" [group-list] ";"`). RFC 9051
 * §7.5.2 represents a group as a START marker `(NIL NIL "groupname" NIL)`, the member
 * mailboxes, then an END marker `(NIL NIL NIL NIL)`. The old code had no group handling
 * at all, so `A Group: a@x, b@y;` glued the group name onto the first mailbox and leaked
 * the closing ';' into the last host — a real ENVELOPE corruption a client mis-displays.
 *
 * One top-level scan (respecting quotes and angle-addr) recognizes the comma that
 * separates mailboxes AND the ':'/';' that bound a group, so a comma inside a quoted
 * display-name (`"Lastname, Firstname"`) is still not a separator.
 */
export function parseAddressList(value: string | null, defects: EnvelopeDefects = {}): readonly EnvelopeAddress[] {
  if (value === null || value.trim() === '') return [];
  const groupsOff = defects.noGroupMarkers === true;
  const out: EnvelopeAddress[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  let inGroup = false;
  const flushMailbox = (): void => {
    const raw = cur.trim();
    cur = '';
    if (raw === '') return;
    const a = parseOneAddress(raw);
    if (a !== null) out.push(a);
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      cur += c;
    } else if (c === '<') {
      inAngle = true;
      cur += c;
    } else if (c === '>') {
      inAngle = false;
      cur += c;
    } else if (c === ':' && !inAngle && !inGroup && !groupsOff) {
      // Group start: the text accumulated so far is the group name phrase.
      out.push(groupStart(cur.trim()));
      cur = '';
      inGroup = true;
    } else if (c === ';' && !inAngle && inGroup && !groupsOff) {
      flushMailbox();
      out.push(groupEnd());
      inGroup = false;
    } else if (c === ',' && !inAngle) {
      flushMailbox();
    } else {
      cur += c;
    }
  }
  flushMailbox();
  // A group left unterminated (no ';') still gets a closing marker, so the structure
  // a client reads is always balanced.
  if (inGroup) out.push(groupEnd());
  return out;
}

function parseOneAddress(raw: string): EnvelopeAddress | null {
  const angle = /^(.*?)<([^>]*)>$/.exec(raw);
  const display = angle ? angle[1]!.trim().replace(/^"|"$/g, '') : null;
  const addr = angle ? angle[2]!.trim() : raw;
  const at = addr.lastIndexOf('@');
  if (at === -1) return { name: display && display.length > 0 ? display : null, mailbox: addr, host: '' };
  return { name: display && display.length > 0 ? display : null, mailbox: addr.slice(0, at), host: addr.slice(at + 1) };
}

export function buildEnvelope(headers: readonly Header[], defects: EnvelopeDefects = {}): Envelope {
  const from = parseAddressList(headerValue(headers, 'From'), defects);

  // R-9051-7.5.2-b: Sender/Reply-To default to From when absent/empty.
  const senderRaw = parseAddressList(headerValue(headers, 'Sender'), defects);
  const replyToRaw = parseAddressList(headerValue(headers, 'Reply-To'), defects);
  const sender = senderRaw.length > 0 ? senderRaw : defects.nilAbsentSender === true ? [] : from;
  const replyTo = replyToRaw.length > 0 ? replyToRaw : defects.nilAbsentSender === true ? [] : from;

  const asVal = (list: readonly EnvelopeAddress[]): EnvelopeValue => (list.length > 0 ? list : null);

  const ordered: Array<{ name: string; value: EnvelopeValue }> = [
    { name: 'date', value: headerValue(headers, 'Date') },
    { name: 'subject', value: headerValue(headers, 'Subject') },
    { name: 'from', value: asVal(from) },
    { name: 'sender', value: asVal(sender) },
    { name: 'reply-to', value: asVal(replyTo) },
    { name: 'to', value: asVal(parseAddressList(headerValue(headers, 'To'), defects)) },
    { name: 'cc', value: asVal(parseAddressList(headerValue(headers, 'Cc'), defects)) },
    { name: 'bcc', value: asVal(parseAddressList(headerValue(headers, 'Bcc'), defects)) },
    { name: 'in-reply-to', value: headerValue(headers, 'In-Reply-To') },
    { name: 'message-id', value: headerValue(headers, 'Message-ID') },
  ];

  if (defects.wrongFieldOrder === true) {
    // Swap subject and from — a client reading positionally now mis-reads both.
    [ordered[1], ordered[2]] = [ordered[2]!, ordered[1]!];
  }

  return { fields: ordered };
}

/** IMAP quoted-string, or NIL for null. CR/LF/NUL and other C0 control octets can't
 * appear in a quoted string (RFC 9051); any that survived unfolding — including a raw
 * NUL from a crafted header — are collapsed to a space, never emitted raw (a NUL would
 * desync a strict client's FETCH parse). */
function imapString(s: string | null): string {
  // eslint-disable-next-line no-control-regex
  return s === null ? 'NIL' : `"${s.replace(/[\x00-\x1f]+/g, ' ').replace(/([\\"])/g, '\\$1')}"`;
}

/** An ENVELOPE address structure: (name adl mailbox host); adl is unused (NIL). */
function serializeAddress(a: EnvelopeAddress): string {
  return `(${imapString(a.name)} NIL ${imapString(a.mailbox)} ${imapString(a.host === '' ? null : a.host)})`;
}

function serializeAddressList(list: readonly EnvelopeAddress[]): string {
  return list.length === 0 ? 'NIL' : `(${list.map(serializeAddress).join('')})`;
}

/** Serialize an ENVELOPE to the IMAP wire form: a parenthesised list in field order. */
export function serializeEnvelope(env: Envelope): string {
  const parts = env.fields.map((f) => {
    if (f.value === null) return 'NIL';
    if (typeof f.value === 'string') return imapString(f.value);
    return serializeAddressList(f.value);
  });
  return `(${parts.join(' ')})`;
}
