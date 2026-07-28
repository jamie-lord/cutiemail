/**
 * RFC 7489 and RFC 9989 — DMARC (record syntax, identifier alignment, policy discovery)
 *
 * RFC 9989 (May 2026) obsoletes 7489. The record grammar and alignment requirements below
 * survive it unchanged and stay cited to 7489, which is what the deployed senders publish
 * against; the requirements this server adopted FROM the replacement — policy discovery by
 * tree walk, its DNS budget, and the `t` test-mode tag — are cited to 9989. What was
 * deliberately not adopted (the `psd` and `np` tags, tree-walk alignment, walking above the
 * organizational domain) is recorded in ADR 0027 rather than left implicit here.
 *
 * DMARC ties SPF and DKIM to the visible RFC5322.From domain: a message passes
 * DMARC only if an authenticated identifier is ALIGNED with the From domain. The
 * two testable, DNS-independent pieces are the record grammar (the "v" and "p"
 * tags, present and ordered; unknown tags ignored) and the alignment comparison
 * (strict = exact FQDN, relaxed = Organizational Domain). Getting alignment wrong
 * is a spoofing hole, so it is negative-controlled.
 *
 * Verbatim quotes from spec/rfc7489.txt and spec/rfc9989.txt. The 9989 entries carry no
 * `page`: that document is in the RFC Editor's unpaginated format, so the section number is
 * the only locator a reader could check.
 */

import type { RequirementDef } from '../../types.ts';

export const DMARC = [
  {
    id: 'R-7489-6.3-a',
    rfc: 'rfc7489',
    section: '6.3',
    page: 24,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'the "v" and "p" tags MUST be present and MUST appear in that order.',
    testability: { kind: 'parse' },
    note:
      'A record is only a DMARC record if it has "v=DMARC1" first and a "p=" policy. ' +
      'Our parser rejects a record missing "p" (or with the tags out of order); the ' +
      'acceptMissingPolicy defect is the negative control — accepting a policy-less ' +
      'record would apply no enforcement while looking valid.',
  },
  {
    id: 'R-7489-6.3-b',
    rfc: 'rfc7489',
    section: '6.3',
    page: 24,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Unknown tags MUST be ignored.',
    testability: { kind: 'parse' },
    note:
      'Forward compatibility: an unrecognised tag must not invalidate the record — ' +
      'the known tags still stand. Our parser keeps parsing past an unknown tag; the ' +
      'failOnUnknownTag defect (let an unknown tag invalidate the record) is the ' +
      'negative control.',
  },
  {
    id: 'R-7489-3.1.1-a',
    rfc: 'rfc7489',
    section: '3.1.1',
    page: 9,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'In strict mode, only an exact match between both of the Fully Qualified Domain Names (FQDNs) is considered to produce Identifier Alignment.',
    testability: { kind: 'parse' },
    note:
      'Identifier alignment: strict requires the authenticated domain (DKIM "d=" or ' +
      'the SPF-checked domain) to EXACTLY equal the RFC5322.From FQDN; relaxed only ' +
      'requires equal Organizational Domains (so "news.example.com" aligns with ' +
      '"example.com"). Our checkAlignment enforces the mode; the strictUsesOrgDomain ' +
      'defect (apply relaxed org-domain matching in strict mode) is the negative ' +
      'control — it would let a subdomain spoof pass strict alignment. (Organizational ' +
      'Domain here is an injected function; the real one needs the Public Suffix List.)',
  },
  {
    id: 'R-9989-4.10.1-a',
    rfc: 'rfc9989',
    section: '4.10.1',
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: "If no valid DMARC Policy Record is found by the first query, then perform a DNS Tree Walk to find the Author Domain's Organizational Domain or its Public Suffix Domain.",
    testability: { kind: 'parse' },
    note:
      'Replaces RFC 7489 §6.6.3\'s single jump from the Author Domain to the Public Suffix ' +
      'List organizational domain, which skips every name in between: for an Author Domain ' +
      'of "alerts.corp.example.com" where only "corp.example.com" publishes a record, 7489 ' +
      'discovery applies NO policy at all. Our walk (dmarc-inbound.ts policyAncestors) visits ' +
      'the intermediate names, floored at the PSL organizational domain rather than continuing ' +
      'to the TLD — so a Public Suffix Domain policy is never applied and no "psd" handling is ' +
      'needed. ADR 0027 records that deviation.',
  },
  {
    id: 'R-9989-4.10.1-b',
    rfc: 'rfc9989',
    section: '4.10.1',
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'In the absence of applicable "sp" or "np" tags, the "p" tag policy is used for subdomains.',
    testability: { kind: 'parse' },
    note:
      'A record discovered ABOVE the Author Domain governs it through "sp" when that tag is ' +
      'published, and through "p" otherwise. Reading "p" where "sp" was published is the ' +
      'negative control: it would apply the apex policy to a subdomain the owner exempted (or ' +
      'vice versa). "np" is deliberately not implemented — it needs a non-existent-domain ' +
      'determination this server does not make — so a published "np" falls through to this ' +
      'same "p" default.',
  },
  {
    id: 'R-9989-4.10.2-a',
    rfc: 'rfc9989',
    section: '4.10.2',
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'Otherwise, select the DMARC Policy Record found at the name with the fewest number of labels.  This is the Organizational Domain and the selection process is complete.',
    testability: { kind: 'parse' },
    note:
      'The counter-intuitive half of the tree walk, and the one an implementation is most ' +
      'likely to get backwards: the walk does NOT stop at the first record it meets going up. ' +
      'Where both an intermediate name and the apex publish, the SHALLOWEST record is selected, ' +
      'not the most specific. Our walk therefore queries shallowest-first and takes the first ' +
      'hit, which is both the correct selection and the cheaper one. Applying the most specific ' +
      'record instead would enforce the wrong domain owner\'s policy.',
  },
  {
    id: 'R-9989-4.10-a',
    rfc: 'rfc9989',
    section: '4.10',
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'To guard against such abuse of the DNS, a shortcut is built into the process so that Author Domains with more than eight labels do not result in more than eight DNS queries.',
    testability: { kind: 'parse' },
    note:
      'The DoS bound, and the reason the walk is safe to run on an unauthenticated path: the ' +
      'Author Domain is attacker-chosen, so without the shortcut a From of a hundred labels ' +
      'buys a hundred DNS queries per message. An Author Domain of eight or more labels jumps ' +
      'straight to its seven-label suffix. Pinned by a 202-label test From.',
  },
  {
    id: 'R-9989-4.7-a',
    rfc: 'rfc9989',
    section: '4.7',
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'if the policy is "quarantine" and the value of the "t" tag is "y", a policy of "none" will be applied to failing messages; if the policy is "reject" and the value of the "t" tag is "y", a policy of "quarantine" will be applied to failing messages',
    testability: { kind: 'parse' },
    note:
      'Test mode: the 9989 successor to "pct", which Appendix A.6 retires to historic. A domain ' +
      'part-way through a rollout publishes its target policy with "t=y" precisely so receivers ' +
      'do not act on it yet; ignoring the tag junks mail its owner explicitly asked to be ' +
      'delivered. checkDmarc returns the DEMOTED policy as `policy`, so the enforcement path ' +
      'cannot forget to apply it, and reports the undemoted one separately for the trace. Only ' +
      'a literal "y" demotes (§4.7: the default is "n"), so a garbled value fails towards ' +
      'enforcing rather than silently disarming. "pct" is still honoured alongside it: senders ' +
      'publish it in quantity, and ignoring it would over-enforce.',
  },
] as const satisfies readonly RequirementDef[];
