/**
 * Inbound DKIM verification (RFC 6376 §6) — the receive-side mirror of the outbound
 * signer. It composes the already-built, vector-pinned crypto: parse the
 * DKIM-Signature (dkim-signature), recompute the body hash (dkim-bodyhash), fetch and
 * parse the signer's public key (dkim-keyrecord, via an injected DNS resolver), and
 * verify the header signature (dkim-verify). The verdict feeds the Authentication-
 * Results the receiver stamps — informational, never a rejection (leniency preserved).
 *
 * Scope: RSA-SHA256 (what Gmail, our own mail, and most senders use). An ed25519
 * signature yields "permerror" for now. Only the first DKIM-Signature is checked.
 * Bytes, never strings: hashing and canonicalisation run on the exact stored octets.
 */

import { createPublicKey } from 'node:crypto';
import { parseMessage } from '../message/parse.ts';
import { parseDkimSignature } from '../crypto/dkim-signature.ts';
import { computeBodyHash, bodyCanonOf, hashAlgoOf } from '../crypto/dkim-bodyhash.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { buildSigningInput, verifySignature, type SignedField, type HeaderCanon } from '../crypto/dkim-verify.ts';

export type DkimVerdict = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';

export interface DkimOutcome {
  readonly verdict: DkimVerdict;
  readonly domain: string | null;
}

/** Resolve a DKIM public-key TXT record for (domain, selector); null if absent. */
export type DkimKeyResolver = (domain: string, selector: string) => Promise<Buffer | null>;

export async function verifyDkim(raw: Buffer, resolveKey: DkimKeyResolver): Promise<DkimOutcome> {
  const { headers, body } = parseMessage(raw);
  const sigHeader = headers.find((h) => h.name.toString('latin1').toLowerCase() === 'dkim-signature');
  if (sigHeader === undefined) return { verdict: 'none', domain: null };

  // Unfold the header value before parsing the tag list.
  const sigValue = sigHeader.value.toString('latin1').replace(/\r\n(?=[ \t])/g, '').trim();
  const sig = parseDkimSignature(Buffer.from(sigValue, 'latin1'));
  if (!sig.valid || sig.domain === null || sig.selector === null || sig.signature === null || sig.bodyHash === null) {
    return { verdict: 'permerror', domain: sig.domain };
  }

  const headerCanon: HeaderCanon = (sig.tags.get('c') ?? '').split('/')[0] === 'relaxed' ? 'relaxed' : 'simple';
  const algo = hashAlgoOf(sig);
  const lTag = sig.tags.get('l');
  const lengthLimit = lTag !== undefined && /^\d+$/.test(lTag) ? Number(lTag) : undefined;

  // Step 1 (RFC 6376 §6.1.3): the body hash must match, else the body was altered.
  if (computeBodyHash(body, bodyCanonOf(sig), algo, lengthLimit) !== sig.bodyHash) {
    return { verdict: 'fail', domain: sig.domain };
  }

  // Step 2: retrieve the public key from DNS.
  let keyBytes: Buffer | null;
  try {
    keyBytes = await resolveKey(sig.domain, sig.selector);
  } catch {
    return { verdict: 'temperror', domain: sig.domain }; // DNS hiccup — retriable, not a failure
  }
  if (keyBytes === null) return { verdict: 'permerror', domain: sig.domain };
  const keyRecord = parseDkimKeyRecord(keyBytes);
  if (!keyRecord.valid || keyRecord.publicKey === null) return { verdict: 'permerror', domain: sig.domain };
  if (keyRecord.keyType === 'ed25519') return { verdict: 'permerror', domain: sig.domain }; // scope: RSA only

  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(keyRecord.publicKey, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return { verdict: 'permerror', domain: sig.domain };
  }

  // Step 3: verify the signature over the signed header fields.
  const signedFields: SignedField[] = [];
  for (const name of sig.signedHeaders) {
    const lower = name.trim().toLowerCase();
    const h = headers.find((x) => x.name.toString('latin1').trim().toLowerCase() === lower);
    if (h !== undefined) signedFields.push({ name: h.name.toString('latin1').trim(), value: h.value.toString('latin1').trim() });
  }
  const nodeAlgo = algo === 'sha1' ? 'RSA-SHA1' : 'RSA-SHA256';
  const ok = verifySignature(buildSigningInput(signedFields, sigValue, headerCanon), sig.signature, publicKey, nodeAlgo);
  return { verdict: ok ? 'pass' : 'fail', domain: sig.domain };
}
