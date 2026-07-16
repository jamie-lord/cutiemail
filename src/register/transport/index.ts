/**
 * The transport-security requirement register: outbound TLS policy. Currently
 * MTA-STS (RFC 8461); DANE is deliberately excluded (ADR 0007), and STARTTLS
 * itself lives in the SMTP register (RFC 3207). TLS-RPT and certificate
 * validation depth follow.
 *
 * Same discipline and library-adapter shape (testability `parse`) as the other
 * register domains.
 */

import type { RequirementDef, IdsOf } from '../types.ts';
import { MTA_STS } from './sections/mta-sts.ts';
import { SMTPUTF8 } from './sections/smtputf8.ts';

/** Sections of the transport RFCs extracted so far (MTA-STS §3.2/§4.1, SMTPUTF8 §3.5). */
export const EXTRACTED_SECTIONS: readonly string[] = ['3.2', '3.5', '4.1'];

export const TRANSPORT_REQUIREMENTS = [...MTA_STS, ...SMTPUTF8] as const satisfies readonly RequirementDef[];

/** Every transport requirement ID as a union — compile-time traceability. */
export type TransportRequirementId = IdsOf<typeof TRANSPORT_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>((TRANSPORT_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]));

export function transportRequirement(id: TransportRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown transport requirement: ${id}`);
  return found;
}
