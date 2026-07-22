/**
 * Inbound DMARC evaluation (RFC 7489) — the third leg of inbound authentication.
 *
 * DMARC ties SPF and DKIM to the RFC 5322 From domain: it passes when at least one of
 * them PASSED *and* its identifier is ALIGNED with the From domain (relaxed = same
 * organizational domain; strict = exact). It composes the tested auth/dmarc.ts
 * (parseDmarcRecord + checkAlignment) with a From-domain extractor, a DNS fetch (with
 * the §6.6.3 organizational-domain fallback), and an org-domain function.
 *
 * The org-domain function uses the full embedded Public Suffix List (auth/public-suffix.ts),
 * so relaxed alignment is computed against the true registered domain even under multi-label
 * public suffixes. This module only EVALUATES — it returns the verdict, the applicable
 * published policy, and pct; the delivery path decides what to do with a failure (ADR 0010:
 * quarantine a policy failure to Junk, never hard-reject).
 */

import { domainToASCII } from 'node:url';
import { parseDmarcRecord, checkAlignment } from '../auth/dmarc.ts';
import { fromAuthor, domainOfAddrSpec } from '../message/from-author.ts';
import { registeredDomain } from '../auth/public-suffix.ts';

export type DmarcVerdict = 'pass' | 'fail' | 'none' | 'temperror';

export interface DmarcInput {
  readonly rawMessage: Buffer;
  /** Every d= whose DKIM signature passed (DMARC aligns against any of them). */
  readonly dkimPassedDomains: readonly string[];
  readonly spfResult: string;
  readonly spfDomain: string;
  /** TXT lookup (each record joined); [] if none, throws on DNS error. */
  readonly resolveTxt: (name: string) => Promise<readonly string[]>;
}

export interface DmarcOutcome {
  readonly verdict: DmarcVerdict;
  readonly policy: string | null;
  readonly fromDomain: string | null;
  /** The published `pct` (0–100): the share of failures the owner wants the policy applied to. */
  readonly pct: number;
}

/**
 * Registered ("organizational") domain via the full Public Suffix List. Unlike the raw
 * `registeredDomain`, this never returns null: a From domain that is itself a bare public
 * suffix (or otherwise has no registrable part) aligns only with itself, so we fall back to
 * the domain as written — DMARC must always have some identifier to compare.
 */
export function organizationalDomain(domain: string): string {
  return registeredDomain(domain) ?? domain.toLowerCase().replace(/\.+$/, '');
}

/**
 * The From domain and how many author mailboxes the message carries. RFC 5322 §3.6.1 requires
 * exactly one From with exactly one mailbox; more than one From header OR a single From holding
 * a mailbox-list is the canonical DMARC display spoof (auth aligns one, the MUA may show
 * another), so the caller must not let count>1 pass. The domain and count come from the shared
 * spoof-hardened author extractor (message/from-author.ts): the SAME parse the submission
 * send-as gate uses, so DMARC alignment and sender-authorization can never disagree.
 */
function fromHeaderInfo(raw: Buffer): { domain: string | null; count: number } {
  const { address, count } = fromAuthor(raw);
  return { domain: address === null ? null : domainOfAddrSpec(address), count };
}

/** The `_dmarc.<domain>` query name, with the domain forced to A-labels so an IDN From (a
 *  U-label domain) resolves against the DNS-published record (RFC 6376/7489: identifiers are
 *  A-labels on the wire). Falls back to the input if domainToASCII cannot encode it. */
function dmarcQueryName(domain: string): string {
  const ascii = domainToASCII(domain);
  return `_dmarc.${ascii === '' ? domain : ascii}`;
}

/**
 * Fetch the applicable DMARC record for a domain. RFC 7489 §6.6.3 step 5: after discarding
 * records that are not DMARC records, "If the remaining set contains multiple records or no
 * records, policy discovery terminates and DMARC processing is not applied", so more than one
 * v=DMARC1 record is reported as `multiple` (a terminal no-policy), never silently first-wins
 * (SPF already rejects multiple records, spf-check.ts). `record` is the single record, or null
 * when none is published.
 */
async function fetchDmarc(domain: string, resolveTxt: DmarcInput['resolveTxt']): Promise<{ record: string | null; multiple: boolean }> {
  const txts = await resolveTxt(dmarcQueryName(domain));
  const found = txts.filter((t) => t.toLowerCase().startsWith('v=dmarc1'));
  if (found.length > 1) return { record: null, multiple: true };
  return { record: found[0] ?? null, multiple: false };
}

export async function checkDmarc(input: DmarcInput): Promise<DmarcOutcome> {
  const { domain: fromDomain, count: fromCount } = fromHeaderInfo(input.rawMessage);
  // §3.6.1: exactly one From is required. More than one is the canonical display-spoof
  // (auth aligns one, the MUA may show another) — never a pass. But do NOT short-circuit
  // here: fall through so the From domain's published policy is fetched, and force the
  // verdict to `fail` below. Short-circuiting with policy=null let a duplicate-From spoof
  // of a p=reject domain reach the INBOX instead of Junk (the enforcement predicate keys
  // on the policy), so the MORE deceptive attack evaded the enforcement the plainer one hit.
  const spoofMultiFrom = fromCount > 1;
  const noPolicy = (): DmarcOutcome => ({ verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, fromDomain, pct: 100 });
  if (fromDomain === null) return { verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, fromDomain: null, pct: 100 };

  let recordText: string | null;
  // Whether the record came from the organizational domain rather than the From domain
  // itself — in that case the subdomain policy (sp=) governs the From (§6.6.3).
  let viaOrgFallback = false;
  try {
    const primary = await fetchDmarc(fromDomain, input.resolveTxt);
    // §6.6.3 step 5: multiple published records terminate discovery with no policy applied.
    if (primary.multiple) return noPolicy();
    recordText = primary.record;
    if (recordText === null) {
      const org = organizationalDomain(fromDomain);
      if (org !== fromDomain) {
        const fallback = await fetchDmarc(org, input.resolveTxt);
        if (fallback.multiple) return noPolicy();
        recordText = fallback.record;
        viaOrgFallback = recordText !== null;
      }
    }
  } catch {
    return { verdict: 'temperror', policy: null, fromDomain, pct: 100 };
  }
  if (recordText === null) return noPolicy();

  const record = parseDmarcRecord(Buffer.from(recordText, 'latin1'));
  if (!record.valid) return { verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, fromDomain, pct: 100 };

  const dkimAligned = input.dkimPassedDomains.some((d) => checkAlignment(fromDomain, d, record.adkim, organizationalDomain));
  const spfAligned = input.spfResult === 'pass' && input.spfDomain !== '' && checkAlignment(fromDomain, input.spfDomain, record.aspf, organizationalDomain);

  // §6.6.3: a subdomain governed by the org-domain record uses sp= (when published),
  // falling back to p=. The applicable policy is what a downstream reader must see.
  const policy = viaOrgFallback && record.subdomainPolicy !== null ? record.subdomainPolicy : record.policy;
  // A multi-From message is a fail regardless of alignment (the display-spoof); with the
  // real policy now fetched, a published quarantine/reject is enforced to Junk.
  const verdict = spoofMultiFrom || !(dkimAligned || spfAligned) ? 'fail' : 'pass';
  return { verdict, policy, fromDomain, pct: record.pct };
}
