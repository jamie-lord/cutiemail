/**
 * DKIM Ed25519-SHA256 signing/verification (RFC 8463), with a defect.
 *
 * The elliptic-curve alternative to rsa-sha256. The signed data is the SHA-256 of
 * the §3.7 header hash input (buildSigningInput), and the signature is Ed25519 over
 * that digest. Node's Ed25519 signs the given bytes directly, so we hash first and
 * sign the digest.
 *
 * Includes a helper to import a raw 32-octet Ed25519 seed (the form RFC 8032 / RFC
 * 8463 publish) into a node KeyObject via the fixed PKCS8 prefix — so the corpus
 * can bind to the RFC vector.
 */

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, createHash, type KeyObject } from 'node:crypto';

/** PKCS8 DER prefix for an Ed25519 private key, followed by the 32-octet seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI DER prefix for an Ed25519 public key, followed by the 32-octet point. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Import a raw 32-octet Ed25519 seed (base64 or Buffer) as a private KeyObject. */
export function importEd25519PrivateKey(seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Import a raw 32-octet Ed25519 public point as a public KeyObject. */
export function importEd25519PublicKey(point: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, point]), format: 'der', type: 'spki' });
}

/** The raw 32-octet public point of an Ed25519 key, base64-encoded (the DKIM p= form). */
export function rawPublicKey(key: KeyObject): string {
  const spki = key.export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

/** Ed25519-SHA256 signature over `input`: Ed25519(privateKey, SHA-256(input)), base64. */
export function signEd25519(input: Buffer, privateKey: KeyObject): string {
  return edSign(null, sha256(input), privateKey).toString('base64');
}

export interface Ed25519VerifyDefects {
  /** Accept without actually checking. Violates R-8463-3-a. */
  readonly skipCheck?: boolean;
}

/** Verify an Ed25519-SHA256 "b=" signature (base64) over `input`. */
export function verifyEd25519(input: Buffer, bValueBase64: string, publicKey: KeyObject, defects: Ed25519VerifyDefects = {}): boolean {
  if (defects.skipCheck === true) return true;
  try {
    return edVerify(null, sha256(input), publicKey, Buffer.from(bValueBase64, 'base64'));
  } catch {
    return false;
  }
}
