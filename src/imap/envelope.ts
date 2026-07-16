/**
 * IMAP FETCH ENVELOPE construction (RFC 9051 §7.5.2), with switchable defects.
 *
 * Turns a message's parsed headers into the fixed-order ENVELOPE structure a client
 * FETCHes. The field order is load-bearing (clients read it positionally) and
 * Sender/Reply-To default to From when absent. This connects the message parser to
 * IMAP output; the raw-message-to-headers parsing is src/message/parse.ts.
 */

import type { Header } from '../message/model.ts';

/** One address in an ENVELOPE address list: (name adl mailbox host). adl is unused (NIL). */
export interface EnvelopeAddress {
  readonly name: string | null;
  readonly mailbox: string;
  readonly host: string;
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
}

/** Case-insensitive first header value, or null. */
function headerValue(headers: readonly Header[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower) return h.value.toString('latin1').trim();
  }
  return null;
}

/** Parse an address list header value into ENVELOPE address structures. */
export function parseAddressList(value: string | null): readonly EnvelopeAddress[] {
  if (value === null || value.trim() === '') return [];
  return value.split(',').map((raw) => parseOneAddress(raw.trim())).filter((a): a is EnvelopeAddress => a !== null);
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
  const from = parseAddressList(headerValue(headers, 'From'));

  // R-9051-7.5.2-b: Sender/Reply-To default to From when absent/empty.
  const senderRaw = parseAddressList(headerValue(headers, 'Sender'));
  const replyToRaw = parseAddressList(headerValue(headers, 'Reply-To'));
  const sender = senderRaw.length > 0 ? senderRaw : defects.nilAbsentSender === true ? [] : from;
  const replyTo = replyToRaw.length > 0 ? replyToRaw : defects.nilAbsentSender === true ? [] : from;

  const asVal = (list: readonly EnvelopeAddress[]): EnvelopeValue => (list.length > 0 ? list : null);

  const ordered: Array<{ name: string; value: EnvelopeValue }> = [
    { name: 'date', value: headerValue(headers, 'Date') },
    { name: 'subject', value: headerValue(headers, 'Subject') },
    { name: 'from', value: asVal(from) },
    { name: 'sender', value: asVal(sender) },
    { name: 'reply-to', value: asVal(replyTo) },
    { name: 'to', value: asVal(parseAddressList(headerValue(headers, 'To'))) },
    { name: 'cc', value: asVal(parseAddressList(headerValue(headers, 'Cc'))) },
    { name: 'bcc', value: asVal(parseAddressList(headerValue(headers, 'Bcc'))) },
    { name: 'in-reply-to', value: headerValue(headers, 'In-Reply-To') },
    { name: 'message-id', value: headerValue(headers, 'Message-ID') },
  ];

  if (defects.wrongFieldOrder === true) {
    // Swap subject and from — a client reading positionally now mis-reads both.
    [ordered[1], ordered[2]] = [ordered[2]!, ordered[1]!];
  }

  return { fields: ordered };
}
