/**
 * The RFC 5321 requirement register — aggregate.
 *
 * The entries live in `sections/`, one module per RFC section, because the
 * register is large, extracted incrementally, and worked on in parallel. This
 * file only stitches them together and derives the ID union.
 *
 * Every entry's `text` is quoted verbatim from spec/rfc5321.txt (RFC 5321,
 * Klensin, October 2008). See src/register/EXTRACTING.md for the contract every
 * section module follows, and docs/decisions/0001-spec-baseline.md for why 5321
 * rather than 5321bis.
 */

import type { RequirementDef, IdsOf } from './types.ts';

import { S2_3_8 } from './sections/s2-3-8.ts';
import { S2_4 } from './sections/s2-4.ts';

/**
 * Sections walked end-to-end, with every normative statement extracted.
 *
 * A section is listed here only once it has been read in full and all of its
 * requirements registered — not when it has been skimmed. **Anything absent
 * from this list is unextracted, not requirement-free.** The coverage report
 * reads this rather than assuming the register is whole, and the register test
 * enforces that it matches the entries in both directions.
 */
export const EXTRACTED_SECTIONS: readonly string[] = ['2.3.8', '2.4'];

export const REQUIREMENTS = [
  ...S2_3_8,
  ...S2_4,
] as const satisfies readonly RequirementDef[];

/**
 * Every registered requirement ID, as a union.
 *
 * This is what makes traceability structural rather than aspirational: a test
 * citing an ID that isn't here fails to compile. See task #10.
 */
export type RequirementId = IdsOf<typeof REQUIREMENTS>;

const byId = new Map<string, RequirementDef>(
  (REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]),
);

export function requirement(id: RequirementId): RequirementDef {
  const found = byId.get(id);
  // Unreachable while `id` is the narrowed union, but the register is data and
  // data gets edited — fail loudly rather than return undefined.
  if (found === undefined) throw new Error(`Unknown requirement: ${id}`);
  return found;
}
