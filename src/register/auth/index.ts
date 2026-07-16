/**
 * The mail-auth requirement register: the sender-authentication requirements this
 * server must honour, quoted verbatim. Currently SPF record syntax + evaluation
 * (RFC 7208); DMARC alignment/policy and DKIM-result feed follow.
 *
 * Same discipline and library-adapter shape (testability `parse`) as the message,
 * crypto and IMAP registers.
 */

import type { RequirementDef, IdsOf } from '../types.ts';
import { SPF_RECORD } from './sections/spf-record.ts';
import { DMARC } from './sections/dmarc.ts';
import { SCRAM } from './sections/scram.ts';
import { SCRAM_MESSAGES } from './sections/scram-messages.ts';
import { ARC } from './sections/arc.ts';

/**
 * Sections extracted so far, across SPF (RFC 7208), DMARC (RFC 7489), SCRAM
 * (RFC 5802 §3/§5.1) and ARC (RFC 8617 §5.2). Each id carries its RFC, so there is
 * no collision between the numbering spaces.
 */
export const EXTRACTED_SECTIONS: readonly string[] = ['3', '3.1.1', '4.5', '4.6.2', '5.1', '5.2', '6.3'];

export const AUTH_REQUIREMENTS = [...SPF_RECORD, ...DMARC, ...SCRAM, ...SCRAM_MESSAGES, ...ARC] as const satisfies readonly RequirementDef[];

/** Every mail-auth requirement ID as a union — compile-time traceability. */
export type AuthRequirementId = IdsOf<typeof AUTH_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>((AUTH_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]));

export function authRequirement(id: AuthRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown auth requirement: ${id}`);
  return found;
}
