/**
 * RFC 5322 §3.4.1 — Addr-Spec Specification
 *
 * The address grammar every mail component leans on (MAIL FROM, RCPT TO, From, To,
 * ...). This is the concrete home of the opinionated-modern cut (ADR 0007 §5a): we
 * accept the dot-atom / quoted-string / address-literal forms modern mail uses and
 * REJECT the obsolete long tail (obs-local-part, obs-domain, comments and folding
 * white space inside an address) that RFC 5322 keeps only for backward compat.
 * Rejecting those is OUR choice, recorded here and tested as parser behaviour; the
 * register entries themselves are the RFC's own requirements.
 *
 * Verbatim quotes from spec/rfc5322.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S3_4_1 = [
  {
    id: 'R-5322-3.4.1-a',
    rfc: 'rfc5322',
    section: '3.4.1',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'An addr-spec is a specific Internet identifier that contains a locally ' +
      'interpreted string followed by the at-sign character',
    testability: { kind: 'parse' },
    note:
      'PROSE MUST — the structure: local-part "@" domain (the at-sign is ASCII 64). ' +
      'A valid addr-spec has exactly one separating @, a non-empty local-part and a ' +
      'non-empty domain. Our opinionated parser splits on that single @ and rejects ' +
      'zero-@, empty-side, and (per ADR 0007) quoted local-parts smuggling an @.',
  },
  {
    id: 'R-5322-3.4.1-b',
    rfc: 'rfc5322',
    section: '3.4.1',
    page: 16,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'the dot-atom form SHOULD be used and the quoted-string form SHOULD NOT be used',
    testability: { kind: 'parse' },
    note:
      'Prefer the plain dot-atom local-part; use the quoted-string form only when a ' +
      'character forces it. Our generator always emits dot-atom where possible; the ' +
      'parser accepts both but records the quoted form as an anomaly (a modern ' +
      'address rarely needs it, so it is worth surfacing).',
  },
  {
    id: 'R-5322-3.4.1-c',
    rfc: 'rfc5322',
    section: '3.4.1',
    page: 16,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Comments and folding white space SHOULD NOT be used around the "@" in the addr-spec',
    testability: { kind: 'parse' },
    note:
      'A SHOULD NOT the RFC states and ADR 0007 hardens into a MUST-reject for us: a ' +
      'modern address has no comments "(...)" or folding white space around the @. ' +
      'Our parser rejects them rather than parsing around them — a smaller, clearer ' +
      'grammar and one fewer confusion surface.',
  },
] as const satisfies readonly RequirementDef[];
