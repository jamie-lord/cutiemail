/**
 * A test-only ARC SEALER (RFC 8617 §5.1) — the sign-side counterpart to the inbound
 * validator. It signs real ARC Sets with generated keys so tests can drive verifyArc
 * against genuinely-sealed messages, exactly as an intermediary (a mailing list) would.
 * ARC sealing is deferred in the product (we never forward — see the roadmap), so this
 * lives under testing/, not in the server; it also stands as an executable reference for
 * the sealing direction should that ever be un-deferred.
 */

import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { computeBodyHash } from '../crypto/dkim-bodyhash.ts';
import { buildAmsInput } from '../crypto/arc-ams.ts';
import { buildSealInput, signSeal, type ArcSetHeaders } from '../crypto/arc-seal.ts';
import { signEd25519, rawPublicKey } from '../crypto/dkim-ed25519.ts';
import type { DkimKeyResolver } from '../server/dkim-inbound.ts';

export type Alg = 'rsa' | 'ed25519';
export interface ArcSigner {
  readonly d: string;
  readonly s: string;
  readonly alg: Alg;
  readonly priv: KeyObject;
  /** The public key in DKIM p= form (SPKI base64 for RSA, raw point base64 for Ed25519). */
  readonly pub: string;
}
export interface HeaderLine {
  readonly name: string;
  readonly value: string;
}

/** Generate an ARC signer (a sealing domain + selector + fresh keypair). */
export function makeArcSigner(d: string, s: string, alg: Alg): ArcSigner {
  if (alg === 'ed25519') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { d, s, alg, priv: privateKey, pub: rawPublicKey(publicKey) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { d, s, alg, priv: privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

const algTag = (alg: Alg): string => (alg === 'ed25519' ? 'ed25519-sha256' : 'rsa-sha256');
const signWith = (input: Buffer, alg: Alg, key: KeyObject): string => {
  if (alg === 'ed25519') return signEd25519(input, key);
  const v = createSign('RSA-SHA256');
  v.update(input);
  v.end();
  return v.sign(key).toString('base64');
};

/** The DKIM-format public-key record (TXT bytes) for a signer, as ARC keys are published. */
export const arcKeyRecord = (sg: ArcSigner): Buffer => Buffer.from(`v=DKIM1; k=${sg.alg}; p=${sg.pub}`, 'latin1');

/** A DKIM key resolver over a set of signers, keyed by "<selector>._domainkey.<domain>". */
export function arcResolver(...signers: ArcSigner[]): DkimKeyResolver {
  const map = new Map(signers.map((sg) => [`${sg.s}._domainkey.${sg.d}`, arcKeyRecord(sg)]));
  return async (domain, selector) => map.get(`${selector}._domainkey.${domain}`) ?? null;
}

/** The header fields the AMS signs (never ARC headers, per §4.1.2). */
const H_LIST = 'from:to:subject:date';

/**
 * Seal one ARC Set over (headers, body) at `instance` with chain-validation status `cv`
 * and an ARC-Authentication-Results result string. `priorSets` are the already-sealed sets
 * (their AS values intact) that this seal must cover. Returns the three ARC header lines to
 * prepend and the raw set (for chaining into the next hop).
 */
export function addArcSet(
  headers: readonly HeaderLine[],
  body: string,
  sg: ArcSigner,
  instance: number,
  cv: 'none' | 'pass' | 'fail',
  aarResult: string,
  priorSets: readonly ArcSetHeaders[],
): { lines: HeaderLine[]; set: ArcSetHeaders } {
  const aar = `i=${instance}; validator.example; ${aarResult}`;

  const bh = computeBodyHash(Buffer.from(body, 'latin1'), 'relaxed', 'sha256');
  const amsBase = `i=${instance}; a=${algTag(sg.alg)}; c=relaxed/relaxed; d=${sg.d}; s=${sg.s}; h=${H_LIST}; bh=${bh}; b=`;
  const signedFields = H_LIST.split(':').map((n) => {
    const h = headers.find((x) => x.name.toLowerCase() === n)!;
    return { name: h.name, value: h.value };
  });
  const ams = amsBase + signWith(buildAmsInput(signedFields, amsBase, 'relaxed'), sg.alg, sg.priv);

  const asBase = `i=${instance}; a=${algTag(sg.alg)}; cv=${cv}; d=${sg.d}; s=${sg.s}; b=`;
  const provisional: ArcSetHeaders = { instance, aar, ams, as: asBase };
  const as = asBase + signSeal(buildSealInput([...priorSets, provisional], instance), sg.alg, sg.priv);

  return {
    lines: [
      { name: 'ARC-Seal', value: as },
      { name: 'ARC-Message-Signature', value: ams },
      { name: 'ARC-Authentication-Results', value: aar },
    ],
    set: { instance, aar, ams, as },
  };
}

/** Assemble raw message bytes from header lines + body. */
export const rawMessageOf = (lines: readonly HeaderLine[], body: string): Buffer =>
  Buffer.from(lines.map((l) => `${l.name}: ${l.value}`).join('\r\n') + '\r\n\r\n' + body, 'latin1');
