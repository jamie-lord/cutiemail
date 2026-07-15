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

// In RFC reading order.
import { S1 } from './sections/s1.ts';
import { S2_1 } from './sections/s2-1.ts';
import { S2_2 } from './sections/s2-2.ts';
import { S2_3_A } from './sections/s2-3-a.ts';
import { S2_3_8 } from './sections/s2-3-8.ts';
import { S2_3_B } from './sections/s2-3-b.ts';
import { S2_4 } from './sections/s2-4.ts';
import { S3_1 } from './sections/s3-1.ts';
import { S3_3 } from './sections/s3-3.ts';
import { S3_4 } from './sections/s3-4.ts';
import { S3_5 } from './sections/s3-5.ts';
import { S3_6 } from './sections/s3-6.ts';
import { S3_7 } from './sections/s3-7.ts';
import { S3_8 } from './sections/s3-8.ts';
import { S4_1_1_A } from './sections/s4-1-1-a.ts';
import { S4_1_1_B } from './sections/s4-1-1-b.ts';
import { S4_1_2 } from './sections/s4-1-2.ts';
import { S4_1_4 } from './sections/s4-1-4.ts';
import { S4_2 } from './sections/s4-2.ts';
import { S4_3 } from './sections/s4-3.ts';
import { S4_4 } from './sections/s4-4.ts';
import { S4_5_1 } from './sections/s4-5-1.ts';
import { S4_5_3_1 } from './sections/s4-5-3-1.ts';
import { S4_5_3_2 } from './sections/s4-5-3-2.ts';
import { S4_5_4 } from './sections/s4-5-4.ts';

/**
 * Sections walked end-to-end, with every normative statement extracted.
 *
 * A section is listed here only once it has been read in full and all of its
 * requirements registered — not when it has been skimmed. **Anything absent
 * from this list is unextracted, not requirement-free.** The coverage report
 * reads this rather than assuming the register is whole, and the register test
 * enforces that it matches the entries in both directions.
 *
 * Still unextracted as of this writing: §5 (Address Resolution), §6 (Problem
 * Detection), §7 (Security Considerations). Tracked in the backlog.
 */
export const EXTRACTED_SECTIONS: readonly string[] = [
  '1.1', '1.2', '1.3',
  '2.1',
  '2.2', '2.2.1', '2.2.2', '2.2.3',
  '2.3.1', '2.3.2', '2.3.3', '2.3.4', '2.3.5', '2.3.6', '2.3.7',
  '2.3.8',
  '2.3.9', '2.3.10', '2.3.11',
  '2.4',
  '3.1', '3.2',
  '3.3',
  '3.4',
  '3.5', '3.5.1', '3.5.2', '3.5.3', '3.5.4',
  '3.6', '3.6.1', '3.6.2', '3.6.3',
  '3.7', '3.7.1', '3.7.2', '3.7.3', '3.7.4', '3.7.5',
  '3.8', '3.9', '3.9.1', '3.9.2',
  '4.1.1', '4.1.1.1', '4.1.1.2', '4.1.1.3', '4.1.1.4',
  '4.1.1.5', '4.1.1.6', '4.1.1.7', '4.1.1.8', '4.1.1.9', '4.1.1.10', '4.1.1.11',
  '4.1.2', '4.1.3',
  '4.1.4', '4.1.5',
  '4.2', '4.2.1', '4.2.2', '4.2.3', '4.2.4', '4.2.5',
  '4.3', '4.3.1', '4.3.2',
  '4.4',
  '4.5.1', '4.5.2',
  '4.5.3.1', '4.5.3.1.1', '4.5.3.1.2', '4.5.3.1.3', '4.5.3.1.4', '4.5.3.1.5',
  '4.5.3.1.6', '4.5.3.1.7', '4.5.3.1.8', '4.5.3.1.9', '4.5.3.1.10',
  '4.5.3.2', '4.5.3.2.1', '4.5.3.2.2', '4.5.3.2.3', '4.5.3.2.4', '4.5.3.2.5',
  '4.5.3.2.6', '4.5.3.2.7',
  '4.5.4', '4.5.4.1', '4.5.4.2', '4.5.5',
];

export const REQUIREMENTS = [
  ...S1,
  ...S2_1,
  ...S2_2,
  ...S2_3_A,
  ...S2_3_8,
  ...S2_3_B,
  ...S2_4,
  ...S3_1,
  ...S3_3,
  ...S3_4,
  ...S3_5,
  ...S3_6,
  ...S3_7,
  ...S3_8,
  ...S4_1_1_A,
  ...S4_1_1_B,
  ...S4_1_2,
  ...S4_1_4,
  ...S4_2,
  ...S4_3,
  ...S4_4,
  ...S4_5_1,
  ...S4_5_3_1,
  ...S4_5_3_2,
  ...S4_5_4,
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
