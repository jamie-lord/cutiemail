/**
 * IMAP SEARCH key matching (RFC 9051 §6.4.4), with a defect.
 *
 * Evaluates a message against a tree of search keys. The keys at the top level are
 * ANDed; NOT and OR nest. Covers the criteria real clients actually send — flag
 * state, header/body/text substrings, INTERNALDATE and Date-header ranges, size —
 * because an unsupported key must be REJECTED by the parser, never silently dropped:
 * dropping "NOT" from "NOT SEEN" would invert the result, and dropping "SINCE" would
 * match everything. The parser (imap-server) enforces that; this evaluates the tree.
 */

import type { Header } from '../message/model.ts';

/** A search key. NOT/OR nest; everything else is a leaf. */
export type SearchKey =
  | { readonly type: 'all' }
  | { readonly type: 'header'; readonly name: string; readonly value: string }
  | { readonly type: 'body' | 'text'; readonly value: string }
  | { readonly type: 'flag'; readonly flag: string; readonly present: boolean }
  | { readonly type: 'date'; readonly field: 'internal' | 'sent'; readonly op: 'since' | 'before' | 'on'; readonly day: number }
  | { readonly type: 'size'; readonly op: 'larger' | 'smaller'; readonly value: number }
  | { readonly type: 'uid'; readonly uids: ReadonlySet<number> }
  | { readonly type: 'seq'; readonly seqs: ReadonlySet<number> }
  | { readonly type: 'not'; readonly key: SearchKey }
  | { readonly type: 'or'; readonly a: SearchKey; readonly b: SearchKey };

export interface SearchableMessage {
  readonly headers: readonly Header[];
  readonly flags: ReadonlySet<string>;
  /** INTERNALDATE as epoch-millis. */
  readonly internalDate: number;
  /** The full raw message bytes (for SIZE and BODY/TEXT substring search). */
  readonly raw: Buffer;
  /** This message's UID and 1-based sequence number, for UID/sequence-set keys. */
  readonly uid: number;
  readonly seq: number;
}

export interface SearchDefects {
  /** OR the top-level keys instead of ANDing them. Violates R-9051-6.4.4-a. */
  readonly orSemantics?: boolean;
}

function headerValue(headers: readonly Header[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower) return h.value.toString('latin1');
  }
  return null;
}

function headerContains(headers: readonly Header[], name: string, needle: string): boolean {
  const v = headerValue(headers, name);
  return v !== null && v.toLowerCase().includes(needle.toLowerCase());
}

/** The UTC day (midnight epoch-millis) a timestamp falls on. */
function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The body bytes (after the header/body separator) as a latin1 string. */
function bodyText(raw: Buffer): string {
  const sep = raw.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  return (sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + 4)).toString('latin1');
}

function matchesKey(msg: SearchableMessage, key: SearchKey): boolean {
  switch (key.type) {
    case 'all':
      return true;
    case 'header':
      return headerContains(msg.headers, key.name, key.value);
    case 'body':
      return bodyText(msg.raw).toLowerCase().includes(key.value.toLowerCase());
    case 'text':
      return msg.raw.toString('latin1').toLowerCase().includes(key.value.toLowerCase());
    case 'flag':
      return msg.flags.has(key.flag) === key.present;
    case 'size':
      return key.op === 'larger' ? msg.raw.length > key.value : msg.raw.length < key.value;
    case 'uid':
      return key.uids.has(msg.uid);
    case 'seq':
      return key.seqs.has(msg.seq);
    case 'not':
      return !matchesKey(msg, key.key);
    case 'or':
      return matchesKey(msg, key.a) || matchesKey(msg, key.b);
    case 'date': {
      if (key.field === 'sent') {
        const raw = headerValue(msg.headers, 'Date');
        const t = raw === null ? NaN : Date.parse(raw);
        if (Number.isNaN(t)) return false;
        return compareDay(utcDay(t), key.op, key.day);
      }
      return compareDay(utcDay(msg.internalDate), key.op, key.day);
    }
  }
}

function compareDay(messageDay: number, op: 'since' | 'before' | 'on', keyDay: number): boolean {
  if (op === 'since') return messageDay >= keyDay; // on or after
  if (op === 'before') return messageDay < keyDay; // strictly before
  return messageDay === keyDay; // on
}

/** Does the message match ALL the top-level keys (AND), per R-9051-6.4.4-a? */
export function matchesSearch(msg: SearchableMessage, keys: readonly SearchKey[], defects: SearchDefects = {}): boolean {
  if (keys.length === 0) return true; // no criteria matches everything
  return defects.orSemantics === true ? keys.some((k) => matchesKey(msg, k)) : keys.every((k) => matchesKey(msg, k));
}
