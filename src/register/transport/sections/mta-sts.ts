/**
 * RFC 8461 — MTA-STS (policy format + MX matching)
 *
 * The opinionated outbound-TLS-policy choice (ADR 0007: MTA-STS, not DANE, since
 * DANE needs DNSSEC which is impractical on Node). A domain publishes a policy
 * saying "my mail is only handled by these MX hosts, over authenticated TLS". The
 * parse-testable, security-load-bearing parts are the policy grammar (version/mode)
 * and — critically — MX pattern matching, where a too-loose wildcard would let an
 * attacker's MX pass validation.
 *
 * Verbatim quotes from spec/rfc8461.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const MTA_STS = [
  {
    id: 'R-8461-3.2-a',
    rfc: 'rfc8461',
    section: '3.2',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Currently, only "STSv1" is supported.',
    testability: { kind: 'parse' },
    note:
      'The version gate: a policy whose version is not "STSv1" is not an MTA-STS ' +
      'policy this spec understands. Our parser rejects a non-STSv1 version; the ' +
      'acceptAnyVersion defect is the negative control.',
  },
  {
    id: 'R-8461-3.2-b',
    rfc: 'rfc8461',
    section: '3.2',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'One of "enforce", "testing", or "none"',
    testability: { kind: 'parse' },
    note:
      'The mode must be one of the three defined values; "enforce" is the one that ' +
      'blocks delivery on a TLS/MX failure. Our parser rejects an unknown mode; the ' +
      'acceptUnknownMode defect is the negative control. (A silently-accepted bad ' +
      'mode could downgrade enforcement to nothing.)',
  },
  {
    id: 'R-8461-4.1-a',
    rfc: 'rfc8461',
    section: '4.1',
    page: 12,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: "the wildcard character '*' may only be used to match the entire left-most label in the presented identifier.",
    testability: { kind: 'parse' },
    note:
      'The load-bearing security rule: "*.example.com" matches "mail.example.com" but ' +
      'NOT "example.com" or "foo.bar.example.com". A wildcard that spans multiple ' +
      'labels would let "evil.attacker.example.com" pass. Our matcher restricts the ' +
      'wildcard to exactly one left-most label; the wildcardMatchesMultipleLabels ' +
      'defect is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
