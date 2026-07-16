/**
 * RFC 9051 (IMAP4rev2) §4.3 — Strings (literals)
 *
 * A literal is how IMAP carries an argument of arbitrary octets (a password, a full
 * message for APPEND): "{n}" CRLF then n octets. The synchronizing form "{n}" makes
 * the client WAIT for a "+" continuation request before sending the octets; the
 * non-synchronizing form "{n+}" does not. Confusing the two desynchronizes the
 * connection, so distinguishing them is the parse gate here. Actual octet-reading
 * and quoted-string handling are later increments.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_LITERALS = [
  {
    id: 'R-9051-4.3-a',
    rfc: 'rfc9051',
    section: '4.3',
    page: 40,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'the client MUST wait to receive a command continuation request (described later in this document) before sending the octet data (and the remainder of the command).',
    testability: { kind: 'parse' },
    note:
      'A synchronizing literal "{n}" requires the client to pause and wait for the ' +
      'server\'s "+" continuation before sending the n octets; the non-synchronizing ' +
      '"{n+}" does not. Our detector reports the octet count and the synchronizing ' +
      'flag so a server knows whether to emit a continuation request; the ' +
      'treatSyncAsNonSync defect (report a "{n}" as non-synchronizing) is the ' +
      'negative control — mishandling it desynchronizes the octet stream.',
  },
] as const satisfies readonly RequirementDef[];
