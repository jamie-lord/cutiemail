/**
 * ARC-Message-Signature verification (RFC 8617 §4.1.2).
 *
 * The AMS is a DKIM signature under the ARC-Message-Signature header name, so this
 * is a thin wrapper over the DKIM header-hash + signature machinery: build the
 * signing input over the ARC-Message-Signature header (b= emptied) and verify. The
 * body hash and canonicalization are the DKIM ones (dkim-bodyhash, dkim-canon).
 */

import { buildSigningInput, verifySignature, type SignedField, type HeaderCanon } from './dkim-verify.ts';

const AMS_HEADER = 'ARC-Message-Signature';

/** Build the AMS header-hash input (the DKIM step 2, but over the AMS header). */
export function buildAmsInput(signedFields: readonly SignedField[], amsValue: string, canon: HeaderCanon): Buffer {
  return buildSigningInput(signedFields, amsValue, canon, AMS_HEADER);
}

/** Verify an AMS RSA signature (base64) over the signed headers + AMS header. */
export function verifyAms(
  signedFields: readonly SignedField[],
  amsValue: string,
  bValueBase64: string,
  publicKey: import('node:crypto').KeyObject,
  canon: HeaderCanon = 'relaxed',
): boolean {
  return verifySignature(buildAmsInput(signedFields, amsValue, canon), bValueBase64, publicKey, 'RSA-SHA256');
}
