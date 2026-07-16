/**
 * RFC 8463 — Ed25519 signing algorithm for DKIM
 *
 * The modern elliptic-curve alternative to RSA for DKIM: smaller keys, smaller
 * signatures, and a MUST for verifiers. The signature is Ed25519 over the SHA-256
 * of the same §3.7 header hash input used for rsa-sha256. RFC 8463 §A ships a
 * keypair (from RFC 8032 §7.1 Test 1), so the corpus binds to a real vector: the
 * public key our code derives from the published secret key must equal the
 * published public key.
 *
 * Verbatim quotes from spec/rfc8463.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_ED25519 = [
  {
    id: 'R-8463-3-a',
    rfc: 'rfc8463',
    section: '3',
    page: 4,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Signers SHOULD implement and verifiers MUST implement the Ed25519-SHA256 algorithm.',
    testability: { kind: 'parse' },
    note:
      'ed25519-sha256: sign/verify Ed25519 over SHA-256 of the §3.7 header hash input. ' +
      'Our verifier implements it (verifiers MUST); a signed message round-trips. ' +
      'Pinned to the RFC 8463 §A vector — the public key derived from the published ' +
      'Ed25519 secret key equals the published public key ' +
      '(11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=). The tamperSignature defect ' +
      '(flip the message) is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
