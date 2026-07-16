/**
 * The IMAP requirement register: the RFC 9051 (IMAP4rev2) requirements this
 * server's IMAP side must honour, quoted verbatim. Currently the response-line
 * surface (§2.2.2, §7.1); command parsing, mailbox state, FETCH/SEARCH and the
 * extensions follow.
 *
 * Same discipline and library-adapter shape (testability `parse`) as the message
 * and crypto registers. Opinionated scope per ADR 0007: IMAP4rev2 only.
 */

import type { RequirementDef, IdsOf } from '../types.ts';
import { IMAP_RESPONSES } from './sections/responses.ts';

/** Sections of RFC 9051 extracted into the register so far. */
export const EXTRACTED_SECTIONS: readonly string[] = ['2.2.2', '7.1'];

export const IMAP_REQUIREMENTS = [...IMAP_RESPONSES] as const satisfies readonly RequirementDef[];

/** Every IMAP requirement ID as a union — compile-time traceability. */
export type ImapRequirementId = IdsOf<typeof IMAP_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>((IMAP_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]));

export function imapRequirement(id: ImapRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown IMAP requirement: ${id}`);
  return found;
}
