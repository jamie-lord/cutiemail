/**
 * The message-format requirement register: every normative requirement from
 * RFC 5322 (Internet Message Format) and the MIME series (RFC 2045-2046) that this
 * server's message parser/generator must honour, quoted verbatim.
 *
 * Same discipline as the SMTP register (src/register/rfc5321.ts): a stable id, the
 * verbatim text (gated against the vendored RFC), the RFC-2119 level, and an honest
 * statement of testability. The difference is the ADAPTER: SMTP requirements are
 * observed over a socket; message-format requirements are observed by feeding input
 * bytes to an in-process parser and checking the result (testability kind `parse`).
 * So the corpus can — and does — exist before the parser it will test.
 *
 * Scope is bounded by docs/decisions/0007-modern-opinionated-scope.md: parse modern
 * mail strictly, reject rather than heroically repair ancient malformations, each
 * rejection recorded. This register grows section by section; EXTRACTED_SECTIONS is
 * the honest denominator of what has been extracted so far.
 */

import type { RequirementDef, IdsOf } from '../types.ts';
import { M_S2_1 } from './sections/s2-1.ts';
import { M_S2_2 } from './sections/s2-2.ts';
import { M_S3_3 } from './sections/s3-3.ts';
import { M_S3_4_1 } from './sections/s3-4-1.ts';
import { M_S3_6 } from './sections/s3-6.ts';
import { M_S2045 } from './sections/s2045.ts';
import { M_S2046 } from './sections/s2046.ts';
import { M_S2047 } from './sections/s2047.ts';

/**
 * Sections extracted into the register so far. RFC 5322 sections (2.x, 3.x) and
 * RFC 2045 MIME sections (4, 5, 5.2, 6) share this list; there is no collision
 * between the two numbering spaces at present.
 */
export const EXTRACTED_SECTIONS: readonly string[] = ['2', '2.1', '2.1.1', '2.2', '3.3', '3.4.1', '3.6', '4', '5', '5.1.1', '5.2', '6', '6.2'];

export const MESSAGE_REQUIREMENTS = [
  ...M_S2_1,
  ...M_S2_2,
  ...M_S3_3,
  ...M_S3_4_1,
  ...M_S3_6,
  ...M_S2045,
  ...M_S2046,
  ...M_S2047,
] as const satisfies readonly RequirementDef[];

/** Every message-format requirement ID as a union — compile-time traceability. */
export type MessageRequirementId = IdsOf<typeof MESSAGE_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>(
  (MESSAGE_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]),
);

export function messageRequirement(id: MessageRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown message requirement: ${id}`);
  return found;
}
