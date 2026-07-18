/**
 * ARC-Seal (AS) signing-input construction + verification (RFC 8617 §5.1.1, §5.2 step 6).
 *
 * The ARC-Seal signs the ARC header SETS, not the message body (§4.1.3: no bh=, no
 * body canonicalization). For the seal at instance M, the signed octets are the sets
 * with instance 1..M in INCREASING order, each contributing its three header fields in
 * the order ARC-Authentication-Results, ARC-Message-Signature, ARC-Seal — always under
 * RELAXED header canonicalization (§4.1.3) — with the sealing AS[M]'s own b= value
 * emptied and no trailing CRLF. That is precisely the DKIM §3.7 step-2 rule, so we reuse
 * the already-vector-pinned buildSigningInput: the only ARC-specific logic is the header
 * ORDERING, which arc-seal.test.ts pins with a golden signing-input assertion.
 *
 * Bytes, never strings: buildSigningInput/relaxedHeaderField operate on octets; the ARC
 * header VALUES are passed through verbatim (relaxed canon unfolds and compresses WSP).
 */

import { createPublicKey } from 'node:crypto';
import { buildSigningInput, verifySignature, type SignedField } from './dkim-verify.ts';
import { verifyEd25519, signEd25519, importEd25519PublicKey } from './dkim-ed25519.ts';
import { createSign, type KeyObject } from 'node:crypto';

/** One hop's three ARC header VALUES (the octets after "ARC-...: "), tagged by instance. */
export interface ArcSetHeaders {
  readonly instance: number;
  /** ARC-Authentication-Results value. */
  readonly aar: string;
  /** ARC-Message-Signature value. */
  readonly ams: string;
  /** ARC-Seal value (its b= is emptied when this set is the one being sealed). */
  readonly as: string;
}

/**
 * Build the exact byte string the ARC-Seal at instance `sealInstance` signs: sets with
 * instance 1..sealInstance in increasing order, each contributing AAR then AMS then AS
 * (relaxed-canon, CRLF-terminated), except the sealing AS[sealInstance] itself, which is
 * appended with b= emptied and NO trailing CRLF. `sets` need not be sorted; instances
 * greater than `sealInstance` are excluded (a seal cannot cover sets added after it).
 */
export function buildSealInput(sets: readonly ArcSetHeaders[], sealInstance: number): Buffer {
  const ordered = sets.filter((s) => s.instance <= sealInstance).sort((a, b) => a.instance - b.instance);
  const signed: SignedField[] = [];
  let sealValue = '';
  for (const s of ordered) {
    signed.push({ name: 'ARC-Authentication-Results', value: s.aar });
    signed.push({ name: 'ARC-Message-Signature', value: s.ams });
    if (s.instance === sealInstance) {
      sealValue = s.as; // the trailing "signature field": b= emptied, no trailing CRLF
    } else {
      signed.push({ name: 'ARC-Seal', value: s.as });
    }
  }
  return buildSigningInput(signed, sealValue, 'relaxed', 'ARC-Seal');
}

/** Verify an ARC-Seal b= signature (base64) over its set-chain input. RSA or Ed25519. */
export function verifySeal(input: Buffer, bValueBase64: string, keyType: 'rsa' | 'ed25519', publicKeyBase64: string): boolean {
  try {
    if (keyType === 'ed25519') {
      return verifyEd25519(input, bValueBase64, importEd25519PublicKey(Buffer.from(publicKeyBase64, 'base64')));
    }
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verifySignature(input, bValueBase64, key, 'RSA-SHA256');
  } catch {
    return false;
  }
}

/**
 * Sign an ARC-Seal input (test/sealer direction — used to prove the verifier round-trips,
 * and available should ARC sealing ever be un-deferred). Returns the base64 b= value.
 */
export function signSeal(input: Buffer, keyType: 'rsa' | 'ed25519', privateKey: KeyObject): string {
  if (keyType === 'ed25519') return signEd25519(input, privateKey);
  const s = createSign('RSA-SHA256');
  s.update(input);
  s.end();
  return s.sign(privateKey).toString('base64');
}
