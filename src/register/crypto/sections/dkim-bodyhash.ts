/**
 * RFC 6376 §3.7 — Computing the Message Hashes (the body hash)
 *
 * The first real cryptographic step: hash the canonicalized body and compare it to
 * the "bh=" tag. This is where the §3.4 canonicalization meets an actual digest —
 * if the body was altered in transit (or canonicalized differently), the hashes
 * diverge and the signature must be rejected. Negative-controlled with a tampered
 * body and a check-skipping defect.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_BODYHASH = [
  {
    id: 'R-6376-3.7-a',
    rfc: 'rfc6376',
    section: '3.7',
    page: 29,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'In hash step 1, the Signer/Verifier MUST hash the message body, canonicalized using the body canonicalization algorithm specified in the "c=" tag',
    testability: { kind: 'parse' },
    note:
      'The body hash: canonicalize the body per the "c=" body mode (§3.4.3/§3.4.4), ' +
      'digest it with the "a=" hash (sha256), base64-encode, and compare to "bh=". ' +
      'Our verifier computes this with node:crypto over the real canon output; a ' +
      'tampered body yields a different hash and fails. The skipBodyHashCheck defect ' +
      '(accept a mismatch) is the negative control — skipping it would let any body ' +
      'ride under a valid-looking signature.',
  },
  {
    id: 'R-6376-3.7-b',
    rfc: 'rfc6376',
    section: '3.7',
    page: 30,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'the value of the "b=" tag (including all surrounding whitespace) deleted (i.e., treated as the empty string), canonicalized using the header canonicalization algorithm specified in the "c=" tag, and without a trailing CRLF.',
    testability: { kind: 'parse' },
    note:
      'The header-hash input (hash step 2): the signed headers per "h=" each ' +
      'canonicalized and CRLF-terminated, then the DKIM-Signature header itself with ' +
      'its own "b=" value emptied, canonicalized, and with NO trailing CRLF. The ' +
      'emptied-b= and no-trailing-CRLF subtleties are where implementations diverge. ' +
      'Our verifier builds this input and checks the RSA signature with node:crypto ' +
      '(a real keypair generated in-test); tampering a signed header changes the ' +
      'input and fails. The skipSignatureCheck defect is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
