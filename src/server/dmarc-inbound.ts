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
 * public suffixes. DMARC is informational: we record the verdict and the published policy,
 * never reject.
 */

import { parseDmarcRecord, checkAlignment } from '../auth/dmarc.ts';
import { parseMessage } from '../message/parse.ts';
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
 * The From domain and how many From headers the message carries. RFC 5322 §3.6.1
 * requires exactly one; a message with more than one is the canonical DMARC display
 * spoof (auth aligns the first, the MUA may show the last), so the caller must not let
 * it pass. The name is trimmed before comparison so `From :` (illegal WSP before the
 * colon, which a lenient MUA still reads as From) can't hide the header from us.
 */
function fromHeaderInfo(raw: Buffer): { domain: string | null; count: number } {
  const { headers } = parseMessage(raw);
  const froms = headers.filter((h) => h.name.toString('latin1').trim().toLowerCase() === 'from');
  if (froms.length === 0) return { domain: null, count: 0 };
  const value = froms[0]!.value.toString('latin1');
  const angle = /<([^>]*)>/.exec(value);
  const addr = (angle ? angle[1]! : value).trim();
  const at = addr.lastIndexOf('@');
  if (at === -1) return { domain: null, count: froms.length };
  // Strip a root-anchoring trailing dot so it aligns with a dot-less DKIM d=/SPF domain.
  const domain = addr.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  return { domain: domain || null, count: froms.length };
}

async function fetchDmarc(domain: string, resolveTxt: DmarcInput['resolveTxt']): Promise<string | null> {
  const txts = await resolveTxt(`_dmarc.${domain}`);
  const found = txts.find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  return found ?? null;
}

export async function checkDmarc(input: DmarcInput): Promise<DmarcOutcome> {
  const { domain: fromDomain, count: fromCount } = fromHeaderInfo(input.rawMessage);
  // §3.6.1: exactly one From is required. More than one can't yield an unambiguous
  // aligned identity — treat it as a fail (a display-spoof), never a pass.
  if (fromCount > 1) return { verdict: 'fail', policy: null, fromDomain };
  if (fromDomain === null) return { verdict: 'none', policy: null, fromDomain: null };

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
    return { verdict: 'temperror', policy: null, fromDomain };
  }
  if (recordText === null) return { verdict: 'none', policy: null, fromDomain };

  const record = parseDmarcRecord(Buffer.from(recordText, 'latin1'));
  if (!record.valid) return { verdict: 'none', policy: null, fromDomain };

  const dkimAligned = input.dkimPassedDomains.some((d) => checkAlignment(fromDomain, d, record.adkim, organizationalDomain));
  const spfAligned = input.spfResult === 'pass' && input.spfDomain !== '' && checkAlignment(fromDomain, input.spfDomain, record.aspf, organizationalDomain);

  // §6.6.3: a subdomain governed by the org-domain record uses sp= (when published),
  // falling back to p=. The applicable policy is what a downstream reader must see.
  const policy = viaOrgFallback && record.subdomainPolicy !== null ? record.subdomainPolicy : record.policy;
  return { verdict: dkimAligned || spfAligned ? 'pass' : 'fail', policy, fromDomain };
}
