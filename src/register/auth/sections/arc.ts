/**
 * RFC 8617 — ARC (Authenticated Received Chain) — chain structure validation
 *
 * ARC preserves SPF/DKIM/DMARC results across forwarding hops (mailing lists,
 * .forward) that would otherwise break DKIM alignment. Each hop adds an ARC Set of
 * three headers (AAR, AMS, AS), numbered by instance. Before any signature crypto,
 * the chain STRUCTURE must hold: sets numbered 1..N with no gaps, and the seal
 * chain-validation "cv" values consistent (i=1 is "none", later ones "pass", none
 * "fail"). A broken structure means the chain cannot be trusted. Negative-controlled.
 *
 * This section is chain structure; the AMS/AS signature verification (which reuses
 * the DKIM machinery) is a later increment. Verbatim quotes from spec/rfc8617.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const ARC = [
  {
    id: 'R-8617-5.2-a',
    rfc: 'rfc8617',
    section: '5.2',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'The instance values of the ARC Sets MUST form a continuous sequence from 1..N with no gaps or repetition.',
    testability: { kind: 'parse' },
    note:
      'A gap or a repeated instance means a hop was dropped or forged — the chain is ' +
      'not continuous and cannot be trusted. Our validator requires the sorted ' +
      'instances to be exactly 1..N; the acceptGaps defect is the negative control.',
  },
  {
    id: 'R-8617-5.2-b',
    rfc: 'rfc8617',
    section: '5.2',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'For the ARC Set with instance value = 1, the value MUST be "none".',
    testability: { kind: 'parse' },
    note:
      'The seal "cv" (chain validation) values must be consistent: the first hop ' +
      'seals with cv=none (there was no prior chain), later hops with cv=pass, and no ' +
      'seal may be cv=fail. Our validator enforces the whole rule; the acceptWrongCv ' +
      'defect (tolerate a wrong or "fail" cv) is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
