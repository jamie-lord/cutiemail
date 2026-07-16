/**
 * RFC 1870 — SMTP SIZE extension (message-size limits)
 *
 * Lets a server advertise a maximum message size and a client declare a message's
 * size on MAIL FROM, so an oversized message is rejected before it is transmitted.
 * Two rules with teeth: an over-limit message is rejected 552, and the declared
 * SIZE must NOT be trusted for framing — the server enforces against the ACTUAL
 * received size, or an under-declaring client bypasses the limit.
 *
 * Verbatim quotes from spec/rfc1870.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SIZE = [
  {
    id: 'R-1870-6.1-a',
    rfc: 'rfc1870',
    section: '6.1',
    page: 5,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'the server responds with code "552 message size exceeds fixed maximium message size".',
    testability: { kind: 'parse' },
    note:
      'A message exceeding the server\'s maximum is rejected 552. Our size check ' +
      'returns 552 for an over-limit message; the ignoreSizeLimit defect (accept it) ' +
      'is the negative control. ("maximium" is the RFC\'s own typo, quoted verbatim.)',
  },
  {
    id: 'R-1870-6-a',
    rfc: 'rfc1870',
    section: '6',
    page: 5,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Servers MUST NOT use the SIZE parameter to determine end of content in the DATA command.',
    testability: { kind: 'parse' },
    note:
      'The declared SIZE is a hint, not a framing authority — the server must enforce ' +
      'against the ACTUAL received bytes, so a client that under-declares cannot smuggle ' +
      'an oversized message past the limit. Our check uses the actual size; the ' +
      'trustDeclaredSize defect (enforce against the declaration) is the negative ' +
      'control.',
  },
] as const satisfies readonly RequirementDef[];
