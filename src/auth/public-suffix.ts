/**
 * The Public Suffix List algorithm (publicsuffix.org/list/#algorithm).
 *
 * Given a domain, find its public suffix (the eTLD under which registrations happen) and
 * its registrable ("organizational") domain — the public suffix plus one more label. DMARC
 * alignment (RFC 7489 §3.2) uses the registrable domain in relaxed mode: two identifiers
 * align if they share one. A too-SHORT organizational domain is the dangerous error — it
 * aligns two unrelated registrants under a shared public suffix and yields a false pass —
 * so this replaces the old hand-maintained ccTLD heuristic with the real list.
 *
 * Matching is done on the punycode (ASCII) form so IDN domains match the list; the returned
 * domain is sliced from the ORIGINAL labels at the same boundary, so a Unicode input yields
 * a Unicode result (and an ASCII input an ASCII result), matching the canonical test suite.
 */

import { domainToASCII } from 'node:url';
import { PSL_RULES, PSL_WILDCARDS, PSL_EXCEPTIONS } from './public-suffix-list.ts';

/** Lower-case, strip a trailing dot, reject the invalid shapes, and produce parallel
 *  original + punycode label arrays (same length). Null for an empty/malformed domain. */
function normalize(domain: string): { orig: string[]; ascii: string[] } | null {
  const lower = domain.toLowerCase().replace(/\.+$/, '');
  if (lower === '' || lower.startsWith('.') || lower.includes('..')) return null;
  const orig = lower.split('.');
  const a = domainToASCII(lower);
  const ascii = a === '' ? orig : a.split('.');
  return ascii.length === orig.length ? { orig, ascii } : { orig, ascii: orig };
}

/**
 * The number of labels in the public suffix of `ascii`, per the PSL algorithm: an exception
 * rule (`!x`) is authoritative and yields its length minus one; otherwise the longest
 * matching normal or wildcard (`*.x`) rule wins; if nothing matches, the default rule "*"
 * makes the rightmost single label the public suffix.
 */
function publicSuffixLen(ascii: string[]): number {
  const n = ascii.length;
  let ruleLen = 0;
  for (let i = 0; i < n; i++) {
    const candidate = ascii.slice(i).join('.');
    if (PSL_EXCEPTIONS.has(candidate)) return n - i - 1; // exception = rule minus its left label
    const len = n - i;
    if (PSL_RULES.has(candidate)) ruleLen = Math.max(ruleLen, len);
    // A wildcard rule "*.X" matches when the labels after position i are exactly X and there
    // is a label at i for the "*" to consume.
    if (i + 1 < n && PSL_WILDCARDS.has(ascii.slice(i + 1).join('.'))) ruleLen = Math.max(ruleLen, len);
  }
  return ruleLen > 0 ? ruleLen : 1;
}

/** The public suffix (eTLD) of a domain, in the input's encoding, or null if invalid/empty. */
export function publicSuffix(domain: string): string | null {
  const norm = normalize(domain);
  if (norm === null) return null;
  const len = publicSuffixLen(norm.ascii);
  if (len > norm.orig.length) return null;
  return norm.orig.slice(norm.orig.length - len).join('.');
}

/**
 * The registrable ("organizational") domain: the public suffix plus one more label, in the
 * input's encoding. Null if the domain IS a public suffix (nothing registrable) or invalid.
 */
export function registeredDomain(domain: string): string | null {
  const norm = normalize(domain);
  if (norm === null) return null;
  const n = norm.orig.length;
  const len = publicSuffixLen(norm.ascii);
  if (n <= len) return null;
  return norm.orig.slice(n - len - 1).join('.');
}
