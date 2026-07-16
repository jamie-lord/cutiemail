/**
 * RFC 8617 §4.1.2 — ARC-Message-Signature (AMS) crypto
 *
 * The ARC-Message-Signature is a DKIM signature over the message under a different
 * header name (no v= tag). Because it shares DKIM's syntax and semantics, its
 * verification reuses the same machinery — canonicalization, the header hash with
 * the b= emptied, and the public-key check — just with the ARC-Message-Signature
 * header. This section covers the AMS signature (the chain-structure rules are in
 * the mail-auth register, R-8617-5.2-a/-b).
 *
 * Verbatim quotes from spec/rfc8617.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const ARC_AMS = [
  {
    id: 'R-8617-4.1.2-a',
    rfc: 'rfc8617',
    section: '4.1.2',
    page: 9,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The AMS header field has the same syntax and semantics as the DKIM-Signature field [RFC6376], with three (3) differences:',
    testability: { kind: 'parse' },
    note:
      'AMS verification is DKIM verification with the ARC-Message-Signature header ' +
      'name (and no v= tag). Our verifier builds the header hash over the signed ' +
      'headers plus the emptied-b= ARC-Message-Signature field and checks the ' +
      'signature — reusing buildSigningInput/verifySignature. A signed AMS ' +
      'round-trips; a tampered message fails. The tamper is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
