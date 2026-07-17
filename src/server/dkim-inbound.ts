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
import { importEd25519PublicKey, verifyEd25519 } from '../crypto/dkim-ed25519.ts';

export type DkimVerdict = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';

export interface DkimOutcome {
  readonly verdict: DkimVerdict;
  /** The domain of a passing signature (for the AR header), or the first seen. */
  readonly domain: string | null;
  /** Every d= whose signature PASSED — DMARC aligns against any of these. */
  readonly passedDomains: readonly string[];
}

/** Resolve a DKIM public-key TXT record for (domain, selector); null if absent. */
export type DkimKeyResolver = (domain: string, selector: string) => Promise<Buffer | null>;

/**
 * Verify every DKIM-Signature on the message (a message may carry several — a
 * forwarder or a multi-key domain adds its own). RFC 6376 §6.1: the message is
 * authenticated if ANY signature verifies, so the overall verdict is "pass" when any
 * passes; the passing domains are returned so DMARC can align against any of them.
 */
export async function verifyDkim(raw: Buffer, resolveKey: DkimKeyResolver): Promise<DkimOutcome> {
  const { headers, body } = parseMessage(raw);
  const sigHeaders = headers.filter((h) => h.name.toString('latin1').toLowerCase() === 'dkim-signature');
  if (sigHeaders.length === 0) return { verdict: 'none', domain: null, passedDomains: [] };

  const results: { verdict: DkimVerdict; domain: string | null }[] = [];
  for (const sigHeader of sigHeaders) {
    results.push(await verifyOneSignature(sigHeader.value.toString('latin1'), headers, body, resolveKey));
  }
  const passing = results.filter((r) => r.verdict === 'pass');
  const passedDomains = passing.map((r) => r.domain).filter((d): d is string => d !== null);
  // Prefer a pass; else surface the strongest negative signal in a stable order.
  const order: DkimVerdict[] = ['pass', 'fail', 'temperror', 'permerror', 'none'];
  const verdict = order.find((v) => results.some((r) => r.verdict === v)) ?? 'none';
  const domain = passing[0]?.domain ?? results[0]?.domain ?? null;
  return { verdict, domain, passedDomains };
}

async function verifyOneSignature(rawValue: string, headers: ReturnType<typeof parseMessage>['headers'], body: Buffer, resolveKey: DkimKeyResolver): Promise<{ verdict: DkimVerdict; domain: string | null }> {
  // Unfold the header value before parsing the tag list.
  const sigValue = rawValue.replace(/\r\n(?=[ \t])/g, '').trim();
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

  // Step 3: build the header-hash input and verify the signature. RSA (rsa-sha256,
  // most senders) and Ed25519 (ed25519-sha256, RFC 8463) share the input; only the
  // public-key import and the verify primitive differ.
  const signedFields: SignedField[] = [];
  for (const name of sig.signedHeaders) {
    const lower = name.trim().toLowerCase();
    const h = headers.find((x) => x.name.toString('latin1').trim().toLowerCase() === lower);
    if (h !== undefined) signedFields.push({ name: h.name.toString('latin1').trim(), value: h.value.toString('latin1').trim() });
  }
  const input = buildSigningInput(signedFields, sigValue, headerCanon);

  let ok: boolean;
  try {
    if (keyRecord.keyType === 'ed25519') {
      ok = verifyEd25519(input, sig.signature, importEd25519PublicKey(Buffer.from(keyRecord.publicKey, 'base64')));
    } else {
      const publicKey = createPublicKey({ key: Buffer.from(keyRecord.publicKey, 'base64'), format: 'der', type: 'spki' });
      ok = verifySignature(input, sig.signature, publicKey, algo === 'sha1' ? 'RSA-SHA1' : 'RSA-SHA256');
    }
  } catch {
    return { verdict: 'permerror', domain: sig.domain };
  }
  return { verdict: ok ? 'pass' : 'fail', domain: sig.domain };
}
