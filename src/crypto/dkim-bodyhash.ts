/**
 * DKIM body-hash computation and verification (RFC 6376 §3.7), with a defect.
 *
 * The first cryptographic step of DKIM verification: canonicalize the body per the
 * signature's "c=" body mode, digest it with the "a=" hash, base64-encode, and
 * compare to the "bh=" tag. This is real crypto (node:crypto) over the reference
 * canonicalization in dkim-canon.ts — the two are wired together here. The "l=" body
 * length limit and the header-hash / "b=" signature verification are later
 * increments; this covers the body-hash half.
 */

import { createHash } from 'node:crypto';
import { simpleBody, relaxedBody } from './dkim-canon.ts';
import type { DkimSignature } from './dkim-signature.ts';

export type BodyCanon = 'simple' | 'relaxed';
export type HashAlgo = 'sha256' | 'sha1';

/** The body canonicalization mode from a "c=" value ("header/body"; body defaults to simple). */
export function bodyCanonOf(sig: DkimSignature): BodyCanon {
  const c = sig.tags.get('c');
  if (c === undefined) return 'simple';
  const body = c.split('/')[1];
  return body === 'relaxed' ? 'relaxed' : 'simple';
}

/** The hash algorithm from an "a=" value ("rsa-sha256" -> sha256). */
export function hashAlgoOf(sig: DkimSignature): HashAlgo {
  const a = sig.algorithm ?? '';
  return a.endsWith('sha1') ? 'sha1' : 'sha256';
}

/**
 * Canonicalize `body` per `canon` and return the base64 digest under `algo`. If
 * `lengthLimit` is given (the "l=" tag), only the first that-many octets of the
 * canonicalized body are hashed — and everything after them is unsigned.
 */
export function computeBodyHash(body: Buffer, canon: BodyCanon, algo: HashAlgo, lengthLimit?: number): string {
  const canonicalized = canon === 'relaxed' ? relaxedBody(body) : simpleBody(body);
  const hashed = lengthLimit === undefined ? canonicalized : canonicalized.subarray(0, lengthLimit);
  return createHash(algo).update(hashed).digest('base64');
}

/** The canonicalized-body length under a signature's body canon mode. */
export function canonicalizedBodyLength(body: Buffer, canon: BodyCanon): number {
  return (canon === 'relaxed' ? relaxedBody(body) : simpleBody(body)).length;
}

export interface BodyHashDefects {
  /** Accept a body-hash mismatch instead of failing. Violates R-6376-3.7-a. */
  readonly skipBodyHashCheck?: boolean;
  /** Accept an "l=" larger than the canonicalized body. Violates R-6376-3.5-d. */
  readonly acceptOverlongL?: boolean;
}

export interface BodyHashResult {
  readonly ok: boolean;
  readonly computed: string;
  readonly expected: string | null;
  /** False when the "l=" tag was larger than the body (R-6376-3.5-d). */
  readonly lengthValid: boolean;
}

/** Verify a message body against a parsed signature's "bh=" tag, honouring "l=". */
export function verifyBodyHash(body: Buffer, sig: DkimSignature, defects: BodyHashDefects = {}): BodyHashResult {
  const canon = bodyCanonOf(sig);
  const lRaw = sig.tags.get('l');
  const l = lRaw === undefined ? undefined : Number(lRaw);

  // R-6376-3.5-d: l= must not exceed the actual canonicalized body length.
  let lengthValid = true;
  if (l !== undefined) {
    const bodyLen = canonicalizedBodyLength(body, canon);
    if (!Number.isInteger(l) || l < 0 || l > bodyLen) {
      lengthValid = defects.acceptOverlongL === true;
    }
  }

  const computed = computeBodyHash(body, canon, hashAlgoOf(sig), l);
  const expected = sig.bodyHash;
  const hashOk = defects.skipBodyHashCheck === true ? true : computed === expected;
  return { ok: hashOk && lengthValid, computed, expected, lengthValid };
}
