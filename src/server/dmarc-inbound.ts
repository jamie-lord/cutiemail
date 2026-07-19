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
 * The From domain and how many From headers the message carries. RFC 5322 §3.6.1 requires
 * exactly one; a message with more than one is the canonical DMARC display spoof (auth aligns
 * the first, the MUA may show the last), so the caller must not let it pass. The domain comes
 * from the shared spoof-hardened author extractor (message/from-author.ts) — the SAME parse
 * the submission send-as gate uses, so DMARC alignment and sender-authorization can never
 * disagree on who the From is.
 */
function fromHeaderInfo(raw: Buffer): { domain: string | null; count: number } {
  const { address, count } = fromAuthor(raw);
  return { domain: address === null ? null : domainOfAddrSpec(address), count };
}

async function fetchDmarc(domain: string, resolveTxt: DmarcInput['resolveTxt']): Promise<string | null> {
  const txts = await resolveTxt(`_dmarc.${domain}`);
  const found = txts.find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  return found ?? null;
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
  if (fromDomain === null) return { verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, fromDomain: null, pct: 100 };

  let recordText: string | null;
  // Whether the record came from the organizational domain rather than the From domain
  // itself — in that case the subdomain policy (sp=) governs the From (§6.6.3).
  let viaOrgFallback = false;
  try {
    recordText = await fetchDmarc(fromDomain, input.resolveTxt);
    if (recordText === null) {
      const org = organizationalDomain(fromDomain);
      if (org !== fromDomain) {
        recordText = await fetchDmarc(org, input.resolveTxt);
        viaOrgFallback = recordText !== null;
      }
    }
  } catch {
    return { verdict: 'temperror', policy: null, fromDomain, pct: 100 };
  }
  if (recordText === null) return { verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, fromDomain, pct: 100 };

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
