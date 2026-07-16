/**
 * RFC 5802 §5.1 — SCRAM message exchange (nonce continuation)
 *
 * The exchange around the proof crypto: client-first carries the client nonce,
 * server-first appends its own to form the full nonce plus the salt and iteration
 * count, and client-final echoes the full nonce with the proof. The security rule
 * that ties them together — and prevents a replay/splice across authentications —
 * is nonce continuation: each side MUST verify the nonce it sees continues the one
 * it expects. Negative-controlled.
 *
 * Verbatim quotes from spec/rfc5802.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SCRAM_MESSAGES = [
  {
    id: 'R-5802-5.1-a',
    rfc: 'rfc5802',
    section: '5.1',
    page: 13,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The client MUST verify that the initial part of the nonce used in subsequent messages is the same as the nonce it initially specified.',
    testability: { kind: 'parse' },
    note:
      'The client checks that the server-first nonce BEGINS WITH the nonce it sent — ' +
      'otherwise the server-first belongs to a different exchange (a splice/replay). ' +
      'Our verifyServerNonce enforces the prefix; the skipNonceCheck defect is the ' +
      'negative control. Pinned to the RFC 5802 §5 example nonce ' +
      '(fyko+d2lbbFgONRv9qkxdawL... continued by 3rfcNHYJY1ZVvWVs7j).',
  },
  {
    id: 'R-5802-5.1-b',
    rfc: 'rfc5802',
    section: '5.1',
    page: 13,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The server MUST verify that the nonce sent by the client in the second message is the same as the one sent by the server in its first message.',
    testability: { kind: 'parse' },
    note:
      'The mirror check on the server side: the client-final nonce must EQUAL the full ' +
      'nonce the server issued in server-first. Our verifyClientNonce enforces ' +
      'equality; the acceptMismatchedNonce defect is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
