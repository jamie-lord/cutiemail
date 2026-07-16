/**
 * IMAP SEARCH key matching (RFC 9051 §6.4.4), with a defect.
 *
 * Evaluates a message against a list of search keys, ANDed together. Covers the
 * common keys — header substring (FROM/SUBJECT/TO), flag presence
 * (SEEN/UNSEEN/DELETED/UNDELETED) — which is enough to pin the load-bearing AND
 * semantics. The full SEARCH grammar (dates, OR/NOT, sequence sets) is a later
 * increment; this establishes the combination rule.
 */

import type { Header } from '../message/model.ts';

export type SearchKey =
  | { readonly type: 'from' | 'to' | 'subject'; readonly value: string }
  | { readonly type: 'seen' | 'unseen' | 'deleted' | 'undeleted' };

export interface SearchableMessage {
  readonly headers: readonly Header[];
  readonly flags: ReadonlySet<string>;
}

export interface SearchDefects {
  /** OR the keys instead of ANDing them. Violates R-9051-6.4.4-a. */
  readonly orSemantics?: boolean;
}

function headerContains(headers: readonly Header[], name: string, needle: string): boolean {
  const lower = name.toLowerCase();
  const want = needle.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower && h.value.toString('latin1').toLowerCase().includes(want)) {
      return true;
    }
  }
  return false;
}

function matchesKey(msg: SearchableMessage, key: SearchKey): boolean {
  switch (key.type) {
    case 'from':
    case 'to':
    case 'subject':
      return headerContains(msg.headers, key.type, key.value);
    case 'seen':
      return msg.flags.has('\\Seen');
    case 'unseen':
      return !msg.flags.has('\\Seen');
    case 'deleted':
      return msg.flags.has('\\Deleted');
    case 'undeleted':
      return !msg.flags.has('\\Deleted');
  }
}

/** Does the message match ALL the keys (AND), per R-9051-6.4.4-a? */
export function matchesSearch(msg: SearchableMessage, keys: readonly SearchKey[], defects: SearchDefects = {}): boolean {
  if (keys.length === 0) return true; // no criteria matches everything
  return defects.orSemantics === true
    ? keys.some((k) => matchesKey(msg, k))
    : keys.every((k) => matchesKey(msg, k));
}
