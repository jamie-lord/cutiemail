/**
 * RFC 6376 §3.6.1 — DKIM Public-Key Record (the DNS TXT record)
 *
 * Where verification gets the public key: the "v=DKIM1; k=...; p=..." TXT record at
 * <selector>._domainkey.<domain>. The parse-testable, security-load-bearing parts
 * are the version discard rule and — critically — revocation: an empty "p=" means
 * the key is revoked, and a verifier that treats an empty key as usable would honor
 * signatures the domain has explicitly withdrawn.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_KEYRECORD = [
  {
    id: 'R-6376-3.6.1-a',
    rfc: 'rfc6376',
    section: '3.6.1',
    page: 27,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Records beginning with a "v=" tag with any other value MUST be discarded.',
    testability: { kind: 'parse' },
    note:
      'The key-record version gate: if a "v=" tag is present it must be exactly ' +
      '"DKIM1" (string compare — "DKIM1.0" does not count) and first, else the record ' +
      'is discarded. Our parser rejects a non-DKIM1 version; the acceptAnyVersion ' +
      'defect is the negative control.',
  },
  {
    id: 'R-6376-3.6.1-b',
    rfc: 'rfc6376',
    section: '3.6.1',
    page: 28,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'An empty value means that this public key has been revoked.',
    testability: { kind: 'parse' },
    note:
      'Revocation: a record with "p=" empty is a tombstone — the key is withdrawn, and ' +
      'a verifier MUST NOT validate signatures against it. Our parser marks an empty ' +
      'p= as revoked (and yields no usable key); the treatEmptyPAsValid defect is the ' +
      'negative control. p= is REQUIRED, so a record missing it entirely is also ' +
      'invalid.',
  },
  {
    id: 'R-6376-3.6.1-c',
    rfc: 'rfc6376',
    section: '3.6.1',
    page: 29,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Verifiers for a given service type MUST ignore this record if the appropriate type is not listed.',
    testability: { kind: 'parse' },
    note:
      'The s= service-type gate: the key applies to the colon-separated services it lists (default ' +
      '"*"), and a verifier for email MUST ignore a record that lists services but neither "email" ' +
      'nor "*" (unrecognized types are ignored). Our parser yields no usable key for such a record; ' +
      'the acceptNonEmailService defect is the negative control. Without it a key published for a ' +
      'different service would still verify mail.',
  },
] as const satisfies readonly RequirementDef[];
