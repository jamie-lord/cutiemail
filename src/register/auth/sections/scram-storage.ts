/**
 * RFC 5802 §1 — SCRAM credential storage (the account database)
 *
 * The defining security property of SCRAM: the server stores only DERIVED keys
 * (StoredKey / ServerKey), never the password, so stealing the account database
 * does not let an attacker impersonate a user. That is what makes SCRAM safe to
 * back with SQLite. Testable directly: a conformant store holds no password, and an
 * attacker with the stored keys cannot forge a client proof (they lack ClientKey,
 * of which StoredKey is a one-way hash).
 *
 * Verbatim quotes from spec/rfc5802.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SCRAM_STORAGE = [
  {
    id: 'R-5802-1-a',
    rfc: 'rfc5802',
    section: '1',
    page: 4,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'The authentication information stored in the authentication database is not sufficient by itself to impersonate the client.',
    testability: { kind: 'parse' },
    note:
      'Our account store persists salt, iterations, StoredKey and ServerKey — and NOT ' +
      'the password. A legitimate client proof verifies; but the stored keys alone ' +
      'cannot forge one (verifyClientProof recovers ClientKey from the proof and ' +
      'checks H(ClientKey) == StoredKey, and StoredKey is a one-way hash of ClientKey). ' +
      'The storePlaintextPassword defect (keep the password in the database) is the ' +
      'negative control — it makes DB theft sufficient to impersonate.',
  },
] as const satisfies readonly RequirementDef[];
