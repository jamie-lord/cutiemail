/**
 * Inbound DMARC evaluation (RFC 7489) — the third leg of inbound authentication.
 *
 * DMARC ties SPF and DKIM to the RFC 5322 From domain: it passes when at least one of
 * them PASSED *and* its identifier is ALIGNED with the From domain (relaxed = same
 * organizational domain; strict = exact). It composes the tested auth/dmarc.ts
 * (parseDmarcRecord + checkAlignment) with a From-domain extractor, a DNS fetch (with
 * the §6.6.3 organizational-domain fallback), and an org-domain function.
 *
 * The org-domain function here is a heuristic (registered-domain = last two labels,
 * with a small multi-part-TLD table), NOT the full Public Suffix List — enough for the
 * common cases; a PSL is a later refinement. DMARC is informational: we record the
 * verdict and the published policy, never reject.
 */

import { parseDmarcRecord, checkAlignment } from '../auth/dmarc.ts';
import { parseMessage } from '../message/parse.ts';

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
 * Common multi-part public suffixes, so the org-domain heuristic does not compute a
 * suffix that is TOO SHORT (e.g. treating "co.za" as the registered domain) — which
 * would wrongly align two unrelated domains under it and yield a false DMARC pass.
 * Not the full Public Suffix List (~10k entries), but covers the ccTLDs real mail uses.
 */
const MULTI_PART_TLDS = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk',
  // Japan / Korea / China / Taiwan / Hong Kong / Singapore
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'co.kr', 'or.kr', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.tw', 'com.hk', 'com.sg',
  // Australia / New Zealand
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  // Brazil / Argentina / Mexico
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.ar', 'com.mx',
  // India / South Africa / Israel / Turkey / Ukraine / Poland / Russia
  'co.in', 'net.in', 'org.in', 'gen.in', 'co.za', 'org.za', 'net.za', 'web.za', 'gov.za', 'co.il', 'com.tr', 'com.ua', 'com.pl', 'com.ru',
  // Kenya / Indonesia / Nigeria / Thailand / Vietnam / Philippines — common registrar
  // second-levels the earlier table omitted (a missing entry is the DANGEROUS direction:
  // it makes the org-domain too short and aligns two unrelated registrants).
  'co.ke', 'or.ke', 'ne.ke', 'go.ke', 'ac.ke', 'co.id', 'or.id', 'ac.id', 'web.id', 'go.id',
  'com.ng', 'org.ng', 'co.th', 'in.th', 'com.vn', 'net.vn', 'com.ph',
]);

/** Registered ("organizational") domain: the last two labels, or three for a known multi-part TLD. */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
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
