/**
 * Inbound DMARC evaluation (RFC 7489) — the third leg of inbound authentication.
 *
 * DMARC ties SPF and DKIM to the RFC 5322 From domain: it passes when at least one of
 * them PASSED *and* its identifier is ALIGNED with the From domain (relaxed = same
 * organizational domain; strict = exact). It composes the tested auth/dmarc.ts
 * (parseDmarcRecord + checkAlignment) with a From-domain extractor, a DNS fetch (walking
 * the ancestors of the From domain, RFC 9989 §4.10.1), and an org-domain function.
 *
 * Policy discovery follows the replacement spec, RFC 9989, within a Public Suffix List
 * floor; alignment still uses the PSL organizational domain rather than 9989's per-identifier
 * tree walk. ADR 0027 records exactly which half is which, and why.
 *
 * The org-domain function uses the full embedded Public Suffix List (auth/public-suffix.ts),
 * so relaxed alignment is computed against the true registered domain even under multi-label
 * public suffixes. This module only EVALUATES — it returns the verdict, the applicable
 * published policy, and pct; the delivery path decides what to do with a failure (ADR 0010:
 * quarantine a policy failure to Junk, never hard-reject).
 */

import { domainToASCII } from 'node:url';
import { parseDmarcRecord, checkAlignment, testModePolicy } from '../auth/dmarc.ts';
import { fromAuthor, domainOfAddrSpec, authorDomains } from '../message/from-author.ts';
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
  /**
   * The policy that GOVERNS this message: the applicable published policy, already demoted
   * if the owner set RFC 9989 §4.7 test mode. The enforcement path reads this and nothing
   * else, so test mode cannot be forgotten at a call site.
   */
  readonly policy: string | null;
  /** What the zone actually says, before any test-mode demotion. Reporting only. */
  readonly publishedPolicy: string | null;
  readonly fromDomain: string | null;
  /** The published `pct` (0–100): the share of failures the owner wants the policy applied to. */
  readonly pct: number;
  /** Whether `t=y` was published, so a trace can explain why an enforcing policy did not fire. */
  readonly testMode: boolean;
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
function fromHeaderInfo(raw: Buffer): { domain: string | null; count: number; present: boolean } {
  const { address, count, value } = fromAuthor(raw);
  return {
    domain: address === null ? null : domainOfAddrSpec(address),
    count,
    // Distinguishing "no From at all" from "a From we could not parse" is load-bearing: the
    // second is a malformed author, not an absent one, and reporting it as an absence of
    // policy meant the most malformed input got the most lenient handling.
    present: value !== null,
  };
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
/**
 * Pick the DMARC record out of a TXT answer, per RFC 7489 §6.6.3 steps 2/4-5 (RFC 9989 §4.10
 * steps 2 and 6 in the replacement): discard everything that does not begin with a `v` tag
 * naming this version, then require exactly one survivor.
 *
 * Exported so `doctor` reports what the daemon — and every conformant receiver — actually does.
 * The two used to spell this differently: doctor trimmed leading whitespace and took the first
 * match with no multiplicity rule, so it answered "ok, p=reject published" for zones where
 * policy discovery yields nothing at all and Gmail and Outlook apply no policy either. A health
 * check that disagrees with enforcement is worse than none, and it is the only DMARC surface an
 * operator sees.
 *
 * The version match is case-sensitive and tolerates `*WSP` around `=`, matching §4.8's
 * `dmarc-version = "v" equals %s"DMARC1"`. Leading whitespace before the `v` is not legal.
 */
export function selectDmarcRecord(txts: readonly string[]): { record: string | null; multiple: boolean } {
  const found = txts.filter((t) => /^v[ \t]*=[ \t]*DMARC1(?:[ \t]*;|$)/.test(t));
  if (found.length > 1) return { record: null, multiple: true };
  return { record: found[0] ?? null, multiple: false };
}

async function fetchDmarc(domain: string, resolveTxt: DmarcInput['resolveTxt']): Promise<{ record: string | null; multiple: boolean }> {
  return selectDmarcRecord(await resolveTxt(dmarcQueryName(domain)));
}

/** RFC 9989 §4.10: a tree walk visits at most eight names, however long the Author Domain. */
const MAX_POLICY_QUERIES = 8;

/**
 * The names above `fromDomain` that may carry the governing policy, ORDERED AS THE
 * SELECTION PREFERS THEM: the organizational domain first, then downward towards (but never
 * reaching) the Author Domain itself.
 *
 * That order is the whole subtlety of RFC 9989 §4.10.2, and it is the opposite of the
 * intuitive one. The tree walk does not stop at the first record it meets going up; it
 * collects them and then, absent a `psd` tag, "select[s] the DMARC Policy Record found at
 * the name with the fewest number of labels". So the SHALLOWEST published record wins, not
 * the most specific — which is why querying shallowest-first and taking the first hit is both
 * correct and cheaper: an ordinary sender one label below its organizational domain still
 * costs the same two lookups it did under 7489.
 *
 * What this buys over RFC 7489's single jump to the organizational domain: a policy
 * published at an intermediate name is currently skipped entirely. For an Author Domain of
 * `alerts.corp.example.com` where `corp.example.com` publishes p=reject and the apex
 * publishes nothing, 7489 discovery looks at the Author Domain, then `example.com`, finds
 * neither, and applies NO policy at all. The walk finds `corp.example.com`.
 *
 * The floor is the PSL organizational domain rather than the TLD, so no `psd` handling is
 * needed and the walk can never apply a public suffix operator's policy (ADR 0027).
 *
 * §4.10 step 4 caps the cost: an Author Domain of eight or more labels jumps straight to its
 * seven-label suffix, so a From of a hundred labels cannot buy a hundred DNS queries on an
 * unauthenticated path. Exported for the test that pins that bound.
 */
export function policyAncestors(fromDomain: string, orgDomain: string): readonly string[] {
  const labels = fromDomain.split('.');
  const orgLabelCount = orgDomain.split('.').length;
  const first = labels.length >= MAX_POLICY_QUERIES ? labels.length - (MAX_POLICY_QUERIES - 1) : 1;
  const names: string[] = [];
  // i counts labels dropped from the left: i=1 is the immediate parent, and the last
  // iteration is the organizational domain itself.
  for (let i = first; i <= labels.length - orgLabelCount; i++) names.push(labels.slice(i).join('.'));
  return names.reverse(); // shallowest (fewest labels) first — the selection order
}

/**
 * Total `_dmarc` lookups one inbound message may buy, across every author domain.
 *
 * RFC 9989 §11.5 prescribes evaluating each Author Domain — and warns in the same paragraph
 * that doing so unboundedly "will expose the Mail Receiver to a form of denial-of-service
 * attack", because the From header is chosen by an unauthenticated peer and each domain costs a
 * tree walk. Capping the DOMAIN count alone still multiplies by the walk; capping the total
 * queries bounds the thing that actually matters. Discovery stops when the budget is spent, and
 * the strictest policy found so far governs.
 */
const MAX_POLICY_QUERIES_PER_MESSAGE = 12;
/** …and a domain count, so one message cannot chase a hundred cheap NXDOMAINs either. */
const MAX_AUTHOR_DOMAINS = 4;

const POLICY_RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
/** How strict a published policy is; an absent policy is weaker than any published one. */
const rankOf = (p: string | null): number => (p === null ? -1 : (POLICY_RANK[p] ?? -1));

/** The first From header's raw value, for the §11.5 multi-domain pass. */
function fromValueOf(raw: Buffer): string {
  return fromAuthor(raw).value ?? '';
}

export async function checkDmarc(input: DmarcInput): Promise<DmarcOutcome> {
  const { domain: fromDomain, count: fromCount, present: fromPresent } = fromHeaderInfo(input.rawMessage);
  // §3.6.1: exactly one From is required. More than one is the canonical display-spoof
  // (auth aligns one, the MUA may show another) — never a pass. But do NOT short-circuit
  // here: fall through so the From domain's published policy is fetched, and force the
  // verdict to `fail` below. Short-circuiting with policy=null let a duplicate-From spoof
  // of a p=reject domain reach the INBOX instead of Junk (the enforcement predicate keys
  // on the policy), so the MORE deceptive attack evaded the enforcement the plainer one hit.
  const spoofMultiFrom = fromCount > 1;
  const noPolicy = (): DmarcOutcome => ({ verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, publishedPolicy: null, fromDomain, pct: 100, testMode: false });
  if (fromDomain === null) {
    // A From header we could not resolve to a queryable domain is a malformed author, and a
    // receiver cannot authenticate what it cannot identify. Reporting `none` here made the
    // outcome depend on how badly the header was mangled: a plain spoof of a p=reject domain
    // was junked, while the same spoof with one extra character became unauthenticatable and
    // was delivered. The verdict is a failure; there is no domain to discover a policy for, so
    // the delivery path applies its own default rather than an owner's.
    return {
      verdict: fromPresent ? 'fail' : 'none',
      policy: null,
      publishedPolicy: null,
      fromDomain: null,
      pct: 100,
      testMode: false,
    };
  }

  // Every `_dmarc` lookup this message may buy, shared across every author domain (§11.5).
  let queriesLeft = MAX_POLICY_QUERIES_PER_MESSAGE;
  const fetchBounded = async (name: string): Promise<{ record: string | null; multiple: boolean }> => {
    if (queriesLeft <= 0) return { record: null, multiple: false };
    queriesLeft--;
    return fetchDmarc(name, input.resolveTxt);
  };

  /**
   * Discovery for ONE author domain: the record at the domain itself, else the first hit
   * walking down from the organizational domain (§4.10.1/§4.10.2). `multiple` means discovery
   * terminated with no policy applied (§6.6.3 step 5).
   */
  const discover = async (
    domain: string,
  ): Promise<{ recordText: string | null; viaParent: boolean; multiple: boolean }> => {
    // §4.10.1: a record at the Author Domain is applied outright and outranks every
    // ancestor, so the common case is still exactly one query.
    const primary = await fetchBounded(domain);
    if (primary.multiple) return { recordText: null, viaParent: false, multiple: true };
    if (primary.record !== null) return { recordText: primary.record, viaParent: false, multiple: false };
    for (const ancestor of policyAncestors(domain, organizationalDomain(domain))) {
      const up = await fetchBounded(ancestor);
      // Terminating here cannot lose a policy that 7489 discovery would have applied: the
      // organizational domain is queried FIRST, so an ancestor is only reached once the
      // organizational domain has been shown to publish nothing.
      if (up.multiple) return { recordText: null, viaParent: false, multiple: true };
      if (up.record !== null) return { recordText: up.record, viaParent: true, multiple: false };
    }
    return { recordText: null, viaParent: false, multiple: false };
  };

  /** Parse a discovered record into the policy that governs, or null if it says nothing. */
  const governingOf = (found: { recordText: string | null; viaParent: boolean; multiple: boolean }) => {
    if (found.multiple || found.recordText === null) return null;
    const rec = parseDmarcRecord(Buffer.from(found.recordText, 'latin1'));
    if (!rec.valid) return null;
    const pub = found.viaParent && rec.subdomainPolicy !== null ? rec.subdomainPolicy : rec.policy;
    return { published: pub, policy: rec.testMode ? testModePolicy(pub) : pub, pct: rec.pct, testMode: rec.testMode };
  };

  // RFC 9989 §11.5, the multi-author-domain case. It is handled on its own path because the
  // verdict does not depend on alignment: §3.6.1 permits exactly one mailbox in From, so more
  // than one is never authentic. What matters is which policy gets ENFORCED, and evaluating a
  // single mailbox let the attacker choose it — the extractor takes the LAST mailbox, so
  // appending a policy-less address of their own left the victim's address displayed first and
  // the message judged a failure against a zone that published nothing. §11.5: "apply the DMARC
  // mechanism to each domain found in the RFC5322.From field as the Author Domain and apply the
  // most strict policy selected among the checks that fail".
  if (spoofMultiFrom) {
    const domains = authorDomains(fromValueOf(input.rawMessage)).slice(0, MAX_AUTHOR_DOMAINS);
    let best: { published: string | null; policy: string | null; pct: number; testMode: boolean } | null = null;
    for (const domain of domains) {
      if (queriesLeft <= 0) break;
      let found;
      try {
        found = await discover(domain);
      } catch {
        continue; // one domain's DNS failure must not discard a policy already found
      }
      const governing = governingOf(found);
      if (governing === null) continue;
      if (best === null || rankOf(governing.published) > rankOf(best.published)) best = governing;
    }
    return {
      verdict: 'fail',
      policy: best?.policy ?? null,
      publishedPolicy: best?.published ?? null,
      fromDomain,
      pct: best?.pct ?? 100,
      testMode: best?.testMode ?? false,
    };
  }

  let recordText: string | null = null;
  // Whether the record came from a name ABOVE the From domain rather than the From domain
  // itself — in that case the subdomain policy (sp=) governs the From (§6.6.3, RFC 9989
  // §4.10.1: "In the absence of applicable "sp" or "np" tags, the "p" tag policy is used
  // for subdomains").
  let viaParent = false;
  try {
    const primary = await discover(fromDomain);
    if (primary.multiple) return noPolicy();
    recordText = primary.recordText;
    viaParent = primary.viaParent;
  } catch {
    return { verdict: 'temperror', policy: null, publishedPolicy: null, fromDomain, pct: 100, testMode: false };
  }
  if (recordText === null) return noPolicy();

  const record = parseDmarcRecord(Buffer.from(recordText, 'latin1'));
  if (!record.valid) return { verdict: spoofMultiFrom ? 'fail' : 'none', policy: null, publishedPolicy: null, fromDomain, pct: 100, testMode: false };

  const dkimAligned = input.dkimPassedDomains.some((d) => checkAlignment(fromDomain, d, record.adkim, organizationalDomain));
  const spfAligned = input.spfResult === 'pass' && input.spfDomain !== '' && checkAlignment(fromDomain, input.spfDomain, record.aspf, organizationalDomain);

  // §6.6.3: a subdomain governed by an ancestor's record uses sp= (when published),
  // falling back to p=. The applicable policy is what a downstream reader must see.
  const publishedPolicy = viaParent && record.subdomainPolicy !== null ? record.subdomainPolicy : record.policy;
  // RFC 9989 §4.7: `t=y` says the owner is still testing and wants the policy applied one
  // level down. `policy` is therefore the policy that GOVERNS, already demoted — there is
  // deliberately no second field for the enforcement path to choose between, and
  // `publishedPolicy` is for reporting only.
  const policy = record.testMode ? testModePolicy(publishedPolicy) : publishedPolicy;
  // A multi-From message is a fail regardless of alignment (the display-spoof); with the
  // real policy now fetched, a published quarantine/reject is enforced to Junk.
  const verdict = spoofMultiFrom || !(dkimAligned || spfAligned) ? 'fail' : 'pass';

  // RFC 9989 §11.5: where the message carries more than one author domain, "apply the DMARC
  // mechanism to each domain found in the RFC5322.From field as the Author Domain and apply
  // the most strict policy selected among the checks that fail".
  //
  // Evaluating only one of them was the bug: the extractor takes the LAST mailbox, so an
  // attacker appended their own policy-less address, the victim's address stayed first (which
  // is what a reader is shown), and the message was correctly judged a failure and then not
  // enforced — because the policy fetched belonged to the attacker's zone and was null. The
  // spoof was detected and then waved through.
  return { verdict, policy, publishedPolicy, fromDomain, pct: record.pct, testMode: record.testMode };
}
