/**
 * DKIM header-hash construction and signature verification (RFC 6376 §3.7 step 2,
 * §6.1), with a defect.
 *
 * Builds the exact byte string the "b=" signature is computed over — the signed
 * header fields (per "h=", each canonicalized and CRLF-terminated) followed by the
 * DKIM-Signature header itself with its "b=" value emptied, canonicalized, and
 * WITHOUT a trailing CRLF — and verifies the RSA signature over it with node:crypto.
 *
 * The emptied-"b=" and no-trailing-CRLF rules are the load-bearing subtleties; get
 * either wrong and every signature fails (or, worse, a tampered one passes). This
 * completes the DKIM verify path started by dkim-canon (§3.4) and dkim-bodyhash
 * (§3.7 step 1). DNS key retrieval is out of scope — the public key is injected.
 */

import { createVerify, type KeyLike } from 'node:crypto';
import { relaxedHeaderField, simpleHeaderField } from './dkim-canon.ts';

export type HeaderCanon = 'simple' | 'relaxed';

export interface SignedField {
  readonly name: string;
  readonly value: string;
}

const CR = 0x0d;
const LF = 0x0a;

/** Empty the "b=" tag's value (up to the next ";" or end), keeping the tag itself. */
export function emptyBTag(dkimSigValue: string): string {
  return dkimSigValue.replace(/(b=)[^;]*/, '$1');
}

/** Canonicalize one header field per the chosen mode. `field` includes a trailing CRLF. */
function canonField(field: Buffer, canon: HeaderCanon): Buffer {
  return canon === 'relaxed' ? relaxedHeaderField(field) : simpleHeaderField(field);
}

/**
 * Build the header-hash input (§3.7 step 2): each signed field canonicalized and
 * CRLF-terminated, then the DKIM-Signature field with "b=" emptied, canonicalized,
 * and without the trailing CRLF.
 */
export function buildSigningInput(
  signedFields: readonly SignedField[],
  dkimSigValue: string,
  canon: HeaderCanon,
  signatureHeaderName = 'DKIM-Signature',
): Buffer {
  const parts: Buffer[] = [];
  for (const f of signedFields) {
    parts.push(canonField(Buffer.from(`${f.name}: ${f.value}\r\n`, 'latin1'), canon));
  }
  let sigField = canonField(Buffer.from(`${signatureHeaderName}: ${emptyBTag(dkimSigValue)}\r\n`, 'latin1'), canon);
  // Remove the trailing CRLF from the DKIM-Signature field only.
  if (sigField.length >= 2 && sigField[sigField.length - 2] === CR && sigField[sigField.length - 1] === LF) {
    sigField = sigField.subarray(0, sigField.length - 2);
  }
  parts.push(sigField);
  return Buffer.concat(parts);
}

export interface SignatureDefects {
  /** Accept without actually checking the signature. Violates R-6376-3.7-b. */
  readonly skipSignatureCheck?: boolean;
}

/**
 * Verify an RSA "b=" signature (base64) over `input` with `publicKey`. `nodeAlgo`
 * is a node:crypto algorithm name, e.g. "RSA-SHA256".
 */
export function verifySignature(
  input: Buffer,
  bValueBase64: string,
  publicKey: KeyLike,
  nodeAlgo: string,
  defects: SignatureDefects = {},
): boolean {
  if (defects.skipSignatureCheck === true) return true;
  const v = createVerify(nodeAlgo);
  v.update(input);
  v.end();
  try {
    return v.verify(publicKey, Buffer.from(bValueBase64, 'base64'));
  } catch {
    return false;
  }
}
