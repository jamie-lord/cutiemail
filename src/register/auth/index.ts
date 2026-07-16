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

/** Sections of the mail-auth RFCs extracted into the register so far. */
export const EXTRACTED_SECTIONS: readonly string[] = ['4.5', '4.6.2'];

export const AUTH_REQUIREMENTS = [...SPF_RECORD] as const satisfies readonly RequirementDef[];

/** Every mail-auth requirement ID as a union — compile-time traceability. */
export type AuthRequirementId = IdsOf<typeof AUTH_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>((AUTH_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]));

export function authRequirement(id: AuthRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown auth requirement: ${id}`);
  return found;
}
