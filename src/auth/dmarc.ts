/**
 * A DMARC record parser and identifier-alignment check (RFC 7489 §6.3/§3.1), with
 * switchable defects.
 *
 * RFC 9989 (May 2026) obsoletes 7489. The record grammar and alignment rules quoted here
 * survive it unchanged; what it adds — the `t` test-mode tag, honoured below — and what it
 * changes elsewhere are recorded in ADR 0027, which says exactly which parts of the
 * replacement this server implements and which it does not.
 *
 * Two pure functions: parse a "v=DMARC1; p=...; ..." record into its tags, and
 * decide whether an authenticated domain is ALIGNED with the RFC5322.From domain
 * under a given mode. DNS lookup of the record and Public Suffix List resolution
 * are out of scope this increment — the Organizational Domain function is injected —
 * which keeps the load-bearing logic (the required/ordered tags, unknown-tag
 * tolerance, and strict-vs-relaxed alignment) testable without a network or a PSL.
 */

import { domainToASCII } from 'node:url';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type AlignmentMode = 'r' | 's';

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];
// `t` is RFC 9989 §4.7's test mode, the successor to `pct` (which that document retires to
// historic in Appendix A.6 but which is still widely published, so both are honoured).
// `np` and `psd` are deliberately absent: they are real 9989 tags, but this server does not
// implement their semantics, and listing a tag we ignore as "known" would claim otherwise.
// Leaving them unknown is both honest and correct — §6.3 requires unknown tags be ignored.
const KNOWN_TAGS = new Set(['v', 'p', 'sp', 'adkim', 'aspf', 'pct', 't', 'rua', 'ruf', 'fo', 'rf', 'ri']);

export interface DmarcRecord {
  readonly valid: boolean;
  readonly version: string | null;
  readonly policy: DmarcPolicy | null;
  readonly subdomainPolicy: DmarcPolicy | null;
  readonly adkim: AlignmentMode;
  readonly aspf: AlignmentMode;
  readonly pct: number;
  /** RFC 9989 §4.7 `t=y`: the owner is testing this policy and asks that it not be applied. */
  readonly testMode: boolean;
  readonly tags: ReadonlyMap<string, string>;
  readonly anomalies: readonly string[];
}

/**
 * RFC 9989 §4.7: under `t=y` the Domain Owner "has an expectation that the policy applied to
 * any failing messages will be one level below the specified policy" — reject becomes
 * quarantine, quarantine becomes none, and none is unaffected.
 *
 * Honouring this matters more than it looks: a domain part-way through a DMARC rollout
 * publishes its target policy with `t=y` precisely so receivers do NOT act on it yet. A
 * receiver that ignores the tag junks mail the owner explicitly asked it to deliver — the
 * exact failure mode that keeps domains parked at p=none for years.
 */
export function testModePolicy(policy: DmarcPolicy | null): DmarcPolicy | null {
  if (policy === 'reject') return 'quarantine';
  if (policy === 'quarantine') return 'none';
  return policy;
}

export interface DmarcParseDefects {
  /** Accept a record with no "p=" policy tag. Violates R-7489-6.3-a. */
  readonly acceptMissingPolicy?: boolean;
  /** Let an unrecognised tag invalidate the record. Violates R-7489-6.3-b. */
  readonly failOnUnknownTag?: boolean;
}

export interface AlignmentDefects {
  /** In strict mode, compare Organizational Domains instead of exact FQDNs. Violates R-7489-3.1.1-a. */
  readonly strictUsesOrgDomain?: boolean;
}

export function parseDmarcRecord(record: Buffer, defects: DmarcParseDefects = {}): DmarcRecord {
  const line = record.toString('latin1').trim();
  const parts = line.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  const tags = new Map<string, string>();
  const order: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim();
    if (!tags.has(name)) order.push(name);
    tags.set(name, val);
  }

  const anomalies: string[] = [];
  let valid = true;

  // R-7489-6.3-a: v=DMARC1 first, and p present, in that order.
  if (tags.get('v') !== 'DMARC1') {
    valid = false;
    anomalies.push('bad-version');
  }
  if (order[0] !== 'v') {
    valid = false;
    anomalies.push('v-not-first');
  }
  const p = tags.get('p');
  if (p === undefined) {
    if (defects.acceptMissingPolicy !== true) {
      valid = false;
      anomalies.push('missing-p');
    }
  } else if (!POLICIES.includes(p)) {
    valid = false;
    anomalies.push('bad-p');
  } else if (order.indexOf('p') < order.indexOf('v')) {
    valid = false;
    anomalies.push('p-before-v');
  }

  // R-7489-6.3-b: unknown tags are ignored (unless the defect makes them fatal).
  for (const name of order) {
    if (!KNOWN_TAGS.has(name)) {
      anomalies.push('unknown-tag-ignored');
      if (defects.failOnUnknownTag === true) valid = false;
    }
  }

  const asMode = (v: string | undefined): AlignmentMode => (v === 's' ? 's' : 'r');
  const pctRaw = Number(tags.get('pct'));
  const pct = Number.isInteger(pctRaw) && pctRaw >= 0 && pctRaw <= 100 ? pctRaw : 100;
  const sp = tags.get('sp');

  return {
    valid,
    version: tags.get('v') ?? null,
    policy: p !== undefined && POLICIES.includes(p) ? (p as DmarcPolicy) : null,
    subdomainPolicy: sp !== undefined && POLICIES.includes(sp) ? (sp as DmarcPolicy) : null,
    adkim: asMode(tags.get('adkim')),
    aspf: asMode(tags.get('aspf')),
    pct,
    // §4.7: "default is 'n'". Only an explicit "y" turns test mode on, so a garbled value
    // fails towards enforcing the published policy rather than silently disarming it.
    testMode: tags.get('t') === 'y',
    tags,
    anomalies,
  };
}

/** Normalize a domain to lower-case A-labels for comparison. An IDN From is often written as
 *  U-labels while a DKIM `d=` / SPF domain is A-labels (RFC 6376 §3.5, §2.3.8: identifiers are
 *  A-labels on the wire); comparing the two encodings directly false-fails legitimate IDN mail
 *  (junked under p=quarantine/reject). domainToASCII is idempotent on an already-ASCII input;
 *  fall back to the lower-cased input if it cannot be encoded (never throw). */
function toAscii(domain: string): string {
  // Strip the root-anchoring trailing dot too: orgDomain (relaxed) does, so leaving it here made
  // adkim=s fail where adkim=r passed for the same pair (RFC 7489 §3.1 compares case-insensitively).
  const lower = domain.toLowerCase().replace(/\.+$/, '');
  const ascii = domainToASCII(lower);
  return ascii === '' ? lower : ascii;
}

/**
 * Is `authDomain` aligned with `fromDomain` under `mode`? Strict requires an exact
 * FQDN match; relaxed requires equal Organizational Domains (via the injected
 * `orgDomain`). Both identifiers are normalized to A-labels first so a U-label From
 * aligns with an A-label `d=` (and vice versa); comparison is case-insensitive.
 */
export function checkAlignment(
  fromDomain: string,
  authDomain: string,
  mode: AlignmentMode,
  orgDomain: (domain: string) => string,
  defects: AlignmentDefects = {},
): boolean {
  const from = toAscii(fromDomain);
  const auth = toAscii(authDomain);
  if (mode === 's' && defects.strictUsesOrgDomain !== true) {
    return from === auth;
  }
  return orgDomain(from) === orgDomain(auth);
}
