/**
 * A DMARC record parser and identifier-alignment check (RFC 7489 §6.3/§3.1), with
 * switchable defects.
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
const KNOWN_TAGS = new Set(['v', 'p', 'sp', 'adkim', 'aspf', 'pct', 'rua', 'ruf', 'fo', 'rf', 'ri']);

export interface DmarcRecord {
  readonly valid: boolean;
  readonly version: string | null;
  readonly policy: DmarcPolicy | null;
  readonly subdomainPolicy: DmarcPolicy | null;
  readonly adkim: AlignmentMode;
  readonly aspf: AlignmentMode;
  readonly pct: number;
  readonly tags: ReadonlyMap<string, string>;
  readonly anomalies: readonly string[];
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
  const lower = domain.toLowerCase();
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
