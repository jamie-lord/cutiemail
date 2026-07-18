/**
 * RFC 8617 §4.1.3 / §5.1.1 — ARC-Seal (AS) crypto.
 *
 * The ARC-Seal is a DKIM-like signature that covers the ARC header SETS (not the body):
 * for the seal at instance M, the sets 1..M in increasing order, each contributing AAR then
 * AMS then AS, under relaxed header canonicalization, with the sealing AS's b= emptied. Our
 * buildSealInput reuses the RFC 6376-pinned buildSigningInput; the only ARC-specific logic
 * is the ordering, pinned by a golden signing-input test (crypto/arc-seal.test.ts) and a
 * sign/verify round-trip. §5.2 step 6 is the validate direction (every seal N..1 must verify).
 *
 * Verbatim quotes from spec/rfc8617.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const ARC_SEAL = [
  {
    id: 'R-8617-4.1.3-a',
    rfc: 'rfc8617',
    section: '4.1.3',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'the signature of the AS header field does not cover the body of the message; therefore, there is no "bh" tag. The signature of the AS header field only covers specific header fields as defined in Section 5.1.1;',
    testability: { kind: 'parse' },
    note:
      'buildSealInput signs only the ARC Set header fields — never the body. There is no ' +
      'body hash. The golden test pins the exact bytes; a round-trip proves sign/verify agree.',
  },
  {
    id: 'R-8617-4.1.3-b',
    rfc: 'rfc8617',
    section: '4.1.3',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'only "relaxed" header field canonicalization ([RFC6376], Section 3.4.2) is used;',
    testability: { kind: 'parse' },
    note: 'buildSealInput always passes canon="relaxed" to buildSigningInput. Fixed, not tag-driven.',
  },
  {
    id: 'R-8617-5.1.1-a',
    rfc: 'rfc8617',
    section: '5.1.1',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The ARC Set header field values are supplied to the hash function in increasing instance order, starting at 1, and include the ARC Set being added at the time of sealing the message.',
    testability: { kind: 'parse' },
    note:
      'buildSealInput orders sets by ascending instance and includes 1..sealInstance. The ' +
      'two-set golden test pins the order; the "excludes later sets" test pins the upper bound.',
  },
  {
    id: 'R-8617-5.1.1-b',
    rfc: 'rfc8617',
    section: '5.1.1',
    page: 15,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Within an ARC Set, header fields are supplied to the hash function in the following order:',
    testability: { kind: 'parse' },
    note:
      'Per set the order is ARC-Authentication-Results, ARC-Message-Signature, ARC-Seal. The ' +
      'golden signing-input test asserts exactly this ordering; a wrong order is the negative control.',
  },
  {
    id: 'R-8617-5.2-c',
    rfc: 'rfc8617',
    section: '5.2',
    page: 17,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'Validate each AS beginning with the greatest instance value and proceeding in decreasing order to the AS with the instance value of 1. If any AS fails to validate, the Chain Validation Status is "fail", and the algorithm stops here.',
    testability: { kind: 'parse' },
    note:
      'verifyArc verifies every seal N..1; a tampered seal yields cv=fail (negative control in ' +
      'server/arc-inbound.test.ts). Paired with §5.2 step 4 (newest AMS) which R-8617-4.1.2-a covers.',
  },
] as const satisfies readonly RequirementDef[];
