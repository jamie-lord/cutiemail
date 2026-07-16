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

/**
 * Sections extracted so far, across SPF (RFC 7208 §4.x), DMARC (RFC 7489 §3.x/§6.x)
 * and SCRAM (RFC 5802 §3). Each id also carries its RFC, so there is no collision.
 */
export const EXTRACTED_SECTIONS: readonly string[] = ['3', '3.1.1', '4.5', '4.6.2', '6.3'];

export const AUTH_REQUIREMENTS = [...SPF_RECORD, ...DMARC, ...SCRAM] as const satisfies readonly RequirementDef[];

/** Every mail-auth requirement ID as a union — compile-time traceability. */
export type AuthRequirementId = IdsOf<typeof AUTH_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>((AUTH_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]));

export function authRequirement(id: AuthRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown auth requirement: ${id}`);
  return found;
}
