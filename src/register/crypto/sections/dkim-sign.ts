/**
 * RFC 6376 §5 — Signer Actions (the outbound signing direction)
 *
 * The complement of verification: producing a DKIM-Signature for outgoing mail. The
 * testable signer obligations are the algorithm choice (rsa-sha256) and a minimum
 * key strength (1024 bits) — a signer that emits a weak key or an odd algorithm
 * produces signatures that verifiers reject or distrust. Proven by a full
 * sign → verify round-trip plus these gates.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_SIGN = [
  {
    id: 'R-6376-5-a',
    rfc: 'rfc6376',
    section: '5',
    page: 12,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Signers MUST implement and SHOULD sign using rsa-sha256.',
    testability: { kind: 'parse' },
    note:
      'The modern signing algorithm. Our signer emits a=rsa-sha256 and computes the ' +
      'signature with RSA-SHA256 over the §3.7 header hash; the useUnknownAlgorithm ' +
      'defect (emit a bogus a=) is the negative control. Proven end-to-end: a signed ' +
      'message round-trips through the §3.7 verifier.',
  },
  {
    id: 'R-6376-5-b',
    rfc: 'rfc6376',
    section: '5',
    page: 26,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Signers MUST use RSA keys of at least 1024 bits for long-lived keys.',
    testability: { kind: 'parse' },
    note:
      'A minimum key strength: a short RSA key succumbs to offline attack. Our signer ' +
      'refuses to sign with a key under 1024 bits; the allowWeakKey defect is the ' +
      'negative control. (Verifiers, by contrast, must validate 512-2048-bit keys — ' +
      'the asymmetry is deliberate.)',
  },
] as const satisfies readonly RequirementDef[];
