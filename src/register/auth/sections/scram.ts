/**
 * RFC 5802 — SCRAM (the proof computation)
 *
 * The opinionated modern authentication choice (ADR 0007: SCRAM-SHA-256 +
 * PLAIN-over-TLS only). SCRAM never sends the password: the client proves knowledge
 * of it, and the server stores only derived keys. The load-bearing, vector-backed
 * core is the proof algebra — ClientProof and ServerSignature — which RFC 5802 §5
 * pins with a worked example (user 'user', password 'pencil'). This register
 * section captures that algebra; the corpus checks our implementation against the
 * RFC's own output.
 *
 * Verbatim quotes from spec/rfc5802.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SCRAM = [
  {
    id: 'R-5802-3-a',
    rfc: 'rfc5802',
    section: '3',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'ClientProof := ClientKey XOR ClientSignature',
    testability: { kind: 'parse' },
    note:
      'The client proof algebra: ClientKey = HMAC(SaltedPassword, "Client Key"), ' +
      'StoredKey = H(ClientKey), ClientSignature = HMAC(StoredKey, AuthMessage), and ' +
      'the proof is ClientKey XOR ClientSignature. The server verifies by recovering ' +
      'ClientKey (proof XOR ClientSignature) and checking H(ClientKey) == StoredKey. ' +
      'Pinned to the RFC 5802 §5 vector (proof v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=); the ' +
      'skipProofCheck defect (accept without verifying) is the negative control, and ' +
      'a wrong password yields a proof that fails.',
  },
  {
    id: 'R-5802-3-b',
    rfc: 'rfc5802',
    section: '3',
    page: 8,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'ServerSignature := HMAC(ServerKey, AuthMessage)',
    testability: { kind: 'parse' },
    note:
      'The server signature the client checks to authenticate the SERVER (mutual ' +
      'auth): ServerKey = HMAC(SaltedPassword, "Server Key"), ServerSignature = ' +
      'HMAC(ServerKey, AuthMessage). Pinned to the RFC 5802 §5 vector ' +
      '(v=rmF9pqV8S7suAoZWja4dJRkFsKQ=). Our computeServerSignature reproduces it ' +
      'exactly; a mismatch means the client would reject the server.',
  },
] as const satisfies readonly RequirementDef[];
