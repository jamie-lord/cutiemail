/**
 * The mail-crypto requirement register: the normative requirements this server's
 * signing/verification code must honour, quoted verbatim. Currently DKIM
 * canonicalization (RFC 6376 §3.4); DKIM signing/verification, ARC and DMARC/SPF
 * alignment follow as those surfaces are built.
 *
 * Same discipline and adapter as the message-format register (testability `parse`:
 * feed input to an in-process function and check the output), so the corpus can
 * precede the implementation. See src/register/message/index.ts for the pattern.
 */

import type { RequirementDef, IdsOf } from '../types.ts';
import { DKIM_CANON } from './sections/dkim-canon.ts';
import { DKIM_SIGNATURE } from './sections/dkim-signature.ts';
import { DKIM_BODYHASH } from './sections/dkim-bodyhash.ts';
import { DKIM_SIGN } from './sections/dkim-sign.ts';
import { DKIM_ED25519 } from './sections/dkim-ed25519.ts';
import { DKIM_KEYRECORD } from './sections/dkim-keyrecord.ts';

/** Sections of the mail-crypto RFCs extracted into the register so far. */
export const EXTRACTED_SECTIONS: readonly string[] = ['3', '3.4.1', '3.4.2', '3.4.3', '3.4.4', '3.5', '3.6.1', '3.7', '5'];

export const CRYPTO_REQUIREMENTS = [
  ...DKIM_CANON,
  ...DKIM_SIGNATURE,
  ...DKIM_BODYHASH,
  ...DKIM_SIGN,
  ...DKIM_ED25519,
  ...DKIM_KEYRECORD,
] as const satisfies readonly RequirementDef[];

/** Every mail-crypto requirement ID as a union — compile-time traceability. */
export type CryptoRequirementId = IdsOf<typeof CRYPTO_REQUIREMENTS>;

const byId = new Map<string, RequirementDef>(
  (CRYPTO_REQUIREMENTS as readonly RequirementDef[]).map((r) => [r.id, r]),
);

export function cryptoRequirement(id: CryptoRequirementId): RequirementDef {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`unknown crypto requirement: ${id}`);
  return found;
}
