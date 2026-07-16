/**
 * RFC 7489 — DMARC (record syntax + identifier alignment)
 *
 * DMARC ties SPF and DKIM to the visible RFC5322.From domain: a message passes
 * DMARC only if an authenticated identifier is ALIGNED with the From domain. The
 * two testable, DNS-independent pieces are the record grammar (the "v" and "p"
 * tags, present and ordered; unknown tags ignored) and the alignment comparison
 * (strict = exact FQDN, relaxed = Organizational Domain). Getting alignment wrong
 * is a spoofing hole, so it is negative-controlled.
 *
 * Verbatim quotes from spec/rfc7489.txt.
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
] as const satisfies readonly RequirementDef[];
