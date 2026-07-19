/**
 * DKIM signing (RFC 6376 §5), with switchable defects.
 *
 * The outbound complement of the verify path: produce a DKIM-Signature header for a
 * message. Reuses the same building blocks as verification — computeBodyHash (§3.7
 * step 1) for bh=, and buildSigningInput (§3.7 step 2) for the header hash — so a
 * message this signs round-trips through the verifier. Real RSA via node:crypto.
 *
 * Enforces the two §5 signer gates: rsa-sha256, and RSA keys of at least 1024 bits.
 * The l=/x=/t= tags, Ed25519, and DNS key publication are later increments.
 */

import { createSign, type KeyObject } from 'node:crypto';
import { computeBodyHash } from './dkim-bodyhash.ts';
import { buildSigningInput, type SignedField, type HeaderCanon } from './dkim-verify.ts';

export interface SignParams {
  readonly domain: string; // d=
  readonly selector: string; // s=
  readonly headerCanon: HeaderCanon;
  readonly bodyCanon: 'simple' | 'relaxed';
  /** The header fields whose octets are hashed, in order (each present header once). */
  readonly signedHeaders: readonly SignedField[];
  /**
   * The `h=` NAME list, if it must differ from `signedHeaders` — used to OVERSIGN (list a name
   * more times than it is hashed, so a prepended instance breaks the signature; RFC 6376
   * §5.4.2 makes the excess entry select the null input at sign time). Defaults to one entry
   * per signed field, which is the ordinary 1:1 case.
   */
  readonly headerNames?: readonly string[];
  readonly body: Buffer;
  readonly privateKey: KeyObject;
}

export interface SignDefects {
  /** Sign with an under-1024-bit key. Violates R-6376-5-b. */
  readonly allowWeakKey?: boolean;
  /** Emit a non-rsa-sha256 algorithm tag. Violates R-6376-5-a. */
  readonly useUnknownAlgorithm?: boolean;
}

export type SignResult = { readonly ok: true; readonly header: string } | { readonly ok: false; readonly error: string };

export function signMessage(params: SignParams, defects: SignDefects = {}): SignResult {
  const bits = params.privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 1024 && defects.allowWeakKey !== true) {
    return { ok: false, error: `RSA key too weak: ${bits} bits (minimum 1024)` };
  }

  const algorithm = defects.useUnknownAlgorithm === true ? 'rsa-md5' : 'rsa-sha256';
  const canonTag = `${params.headerCanon}/${params.bodyCanon}`;
  const bh = computeBodyHash(params.body, params.bodyCanon, 'sha256');
  const h = (params.headerNames ?? params.signedHeaders.map((f) => f.name)).map((n) => n.toLowerCase()).join(':');

  // Assemble the tag-list with an empty b=, sign over it, then fill b= in.
  const sigValue =
    `v=1; a=${algorithm}; c=${canonTag}; d=${params.domain}; s=${params.selector}; ` +
    `h=${h}; bh=${bh}; b=`;
  const input = buildSigningInput(params.signedHeaders, sigValue, params.headerCanon);
  const s = createSign('RSA-SHA256');
  s.update(input);
  s.end();
  const b = s.sign(params.privateKey).toString('base64');

  return { ok: true, header: sigValue + b };
}
