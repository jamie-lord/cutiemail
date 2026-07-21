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
  /**
   * The VERBATIM field octets (name + ':' + value, original whitespace and folds, no trailing
   * CRLF). Used only for `simple` header canon, which RFC 6376 §3.4.1 defines as the field
   * byte-for-byte. Without it, `simple` canon was reconstructed from the trimmed `name`/`value`
   * with one forced post-colon space — which both rejected legitimate simple-canon signatures
   * (non-single-space/trailing-WSP headers) AND let a verifier re-collapse a whitespace-tampered
   * signed header back to the signed form and PASS it. `relaxed` canon ignores it
   * (it normalises whitespace itself), so signers/ARC that omit it are unaffected.
   */
  readonly raw?: Buffer;
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
    // For `simple` canon the field must be hashed verbatim (§3.4.1). Use the raw octets when
    // the caller supplied them; the trimmed name/value reconstruction is only correct for
    // `relaxed` (which normalises whitespace regardless).
    const field =
      canon === 'simple' && f.raw !== undefined
        ? Buffer.concat([f.raw, Buffer.from([CR, LF])])
        : Buffer.from(`${f.name}: ${f.value}\r\n`, 'latin1');
    parts.push(canonField(field, canon));
  }
  let sigField = canonField(Buffer.from(`${signatureHeaderName}: ${emptyBTag(dkimSigValue)}\r\n`, 'latin1'), canon);
  // Remove the trailing CRLF from the DKIM-Signature field only.
  if (sigField.length >= 2 && sigField[sigField.length - 2] === CR && sigField[sigField.length - 1] === LF) {
    sigField = sigField.subarray(0, sigField.length - 2);
  }
  parts.push(sigField);
  return Buffer.concat(parts);
}

/** A raw header field as parsed from a message — name and value octets, verbatim. */
export interface RawHeaderField {
  readonly name: Buffer;
  readonly value: Buffer;
}

/**
 * Select the header fields to hash for an `h=` list, per RFC 6376 §5.4.2: walk the names left
 * to right and, for each, take the NEXT UNUSED instance of that field from the BOTTOM of the
 * header block upward. A name listed in `h=` more times than it occurs (or not at all)
 * contributes the null input for each excess — nothing is hashed for it. Both the signer and
 * the verifier build their header-hash input through THIS one function, so they can never
 * disagree on which bytes are covered.
 *
 * This bottom-up, instance-consuming selection is what makes OVERSIGNING sound. A signer that
 * lists `from` once more than it appears binds "there is no second From" into the signature:
 * an attacker who PREPENDS a second From makes the excess `h=from` consume that forged header
 * (instead of the null input), so the hash no longer matches and the replay fails. The former
 * top-down, non-consuming `find` picked the same first instance for every `h=` entry and
 * hashed nothing for exhausted names, so a prepended From verified against the original — the
 * bug this fixes.
 */
export function selectSignedFields(headers: readonly RawHeaderField[], hNames: readonly string[]): SignedField[] {
  // Instance indices per lower-cased name, in document (top-to-bottom) order.
  const remaining = new Map<string, number[]>();
  headers.forEach((h, i) => {
    const key = h.name.toString('latin1').trim().toLowerCase();
    const list = remaining.get(key);
    if (list === undefined) remaining.set(key, [i]);
    else list.push(i);
  });
  const out: SignedField[] = [];
  for (const rawName of hNames) {
    const idxs = remaining.get(rawName.trim().toLowerCase());
    if (idxs === undefined || idxs.length === 0) continue; // exhausted / absent → null input (§5.4.2)
    const h = headers[idxs.pop()!]!; // pop = the next instance from the bottom up
    // Carry the verbatim octets (name : value, original whitespace/folds) so `simple` header
    // canon hashes them byte-for-byte (§3.4.1); `relaxed` rebuilds from the trimmed name/value.
    const raw = Buffer.concat([h.name, Buffer.from(':', 'latin1'), h.value]);
    out.push({ name: h.name.toString('latin1').trim(), value: h.value.toString('latin1').trim(), raw });
  }
  return out;
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
