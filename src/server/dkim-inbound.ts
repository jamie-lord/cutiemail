/**
 * Inbound DKIM verification (RFC 6376 §6) — the receive-side mirror of the outbound
 * signer. It composes the already-built, vector-pinned crypto: parse the
 * DKIM-Signature (dkim-signature), recompute the body hash (dkim-bodyhash), fetch and
 * parse the signer's public key (dkim-keyrecord, via an injected DNS resolver), and
 * verify the header signature (dkim-verify). The verdict feeds the Authentication-
 * Results the receiver stamps — informational, never a rejection (leniency preserved).
 *
 * Scope: RSA-SHA256 (what Gmail, our own mail, and most senders use). An ed25519
 * signature yields "permerror" for now. Every DKIM-Signature is checked, up to a
 * hard cap (MAX_DKIM_SIGNATURES) — see the DoS note on that constant.
 * Bytes, never strings: hashing and canonicalisation run on the exact stored octets.
 */

import { createPublicKey, createHash } from 'node:crypto';
import { parseMessage } from '../message/parse.ts';
import { parseDkimSignature } from '../crypto/dkim-signature.ts';
import { bodyCanonOf, hashAlgoOf, type BodyCanon, type HashAlgo } from '../crypto/dkim-bodyhash.ts';
import { simpleBody, relaxedBody } from '../crypto/dkim-canon.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { buildSigningInput, selectSignedFields, verifySignature, type HeaderCanon } from '../crypto/dkim-verify.ts';
import { importEd25519PublicKey, verifyEd25519 } from '../crypto/dkim-ed25519.ts';

export type DkimVerdict = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';

/**
 * The maximum number of DKIM-Signature headers verified per message. Each signature
 * costs a full-body canonicalisation + hash BEFORE any DNS lookup (a bogus bh= fails
 * before the resolver is even called), all synchronous on the single event-loop thread.
 * Without a cap, one unauthenticated ≤25 MiB message packed with signature headers
 * freezes every listener for minutes (a self-inflicted DoS). Real mail carries at most a
 * few signatures (author + a forwarder/list, or a dual RSA+Ed25519 pair); 10 is generous.
 * A message burying its one valid signature past the cap is treated as abusive — the
 * signatures beyond the cap are not verified. The ARC path caps sets the same way.
 */
export const MAX_DKIM_SIGNATURES = 10;

/**
 * Memoises the body canonicalisation + hash across a message's signatures. The body is
 * the same bytes for every signature, so canonicalising it once per mode (simple/relaxed)
 * and caching each digest by (mode, algo, l=) collapses the per-signature body work from
 * O(N·bodylen) to O(bodylen) — the other half of the signature-count DoS fix. Bounded
 * anyway by MAX_DKIM_SIGNATURES, but this also kills the relaxed-canonicalisation
 * amplification (relaxedBody is the expensive step) even within the cap.
 */
class BodyHashMemo {
  readonly #body: Buffer;
  readonly #canon = new Map<BodyCanon, Buffer>();
  readonly #digest = new Map<string, string>();
  constructor(body: Buffer) {
    this.#body = body;
  }
  /** The canonicalised body for `canon`, computed at most once per mode. */
  canonicalized(canon: BodyCanon): Buffer {
    let c = this.#canon.get(canon);
    if (c === undefined) {
      c = canon === 'relaxed' ? relaxedBody(this.#body) : simpleBody(this.#body);
      this.#canon.set(canon, c);
    }
    return c;
  }
  /** base64 digest of the (optionally l=-truncated) canonicalised body, memoised by key. */
  digest(canon: BodyCanon, algo: HashAlgo, lengthLimit: number | undefined): string {
    const key = `${canon}|${algo}|${lengthLimit ?? ''}`;
    let d = this.#digest.get(key);
    if (d === undefined) {
      const c = this.canonicalized(canon);
      const hashed = lengthLimit === undefined ? c : c.subarray(0, lengthLimit);
      d = createHash(algo).update(hashed).digest('base64');
      this.#digest.set(key, d);
    }
    return d;
  }
}

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

  // Cap the number of signatures verified (DoS defense — see MAX_DKIM_SIGNATURES) and
  // share one body-hash memo across them so the body is canonicalised once per mode.
  const memo = new BodyHashMemo(body);
  const results: { verdict: DkimVerdict; domain: string | null }[] = [];
  for (const sigHeader of sigHeaders.slice(0, MAX_DKIM_SIGNATURES)) {
    results.push(await verifyOneSignature(sigHeader.value.toString('latin1'), headers, memo, resolveKey));
  }
  const passing = results.filter((r) => r.verdict === 'pass');
  const passedDomains = passing.map((r) => r.domain).filter((d): d is string => d !== null);
  // Prefer a pass; else surface the strongest negative signal in a stable order.
  const order: DkimVerdict[] = ['pass', 'fail', 'temperror', 'permerror', 'none'];
  const verdict = order.find((v) => results.some((r) => r.verdict === v)) ?? 'none';
  const domain = passing[0]?.domain ?? results[0]?.domain ?? null;
  return { verdict, domain, passedDomains };
}

async function verifyOneSignature(rawValue: string, headers: ReturnType<typeof parseMessage>['headers'], memo: BodyHashMemo, resolveKey: DkimKeyResolver): Promise<{ verdict: DkimVerdict; domain: string | null }> {
  // Unfold the header value before parsing the tag list.
  const sigValue = rawValue.replace(/\r\n(?=[ \t])/g, '').trim();
  const sig = parseDkimSignature(Buffer.from(sigValue, 'latin1'));
  if (!sig.valid || sig.domain === null || sig.selector === null || sig.signature === null || sig.bodyHash === null) {
    return { verdict: 'permerror', domain: sig.domain };
  }

  // RFC 6376 §5.4: the From header MUST be signed. A signature that omits it is
  // meaningless — an attacker could sign an innocuous message and swap the From, and
  // it would still "verify". Reject it (this is also what makes DKIM sound for DMARC).
  if (!sig.signedHeaders.some((h) => h.trim().toLowerCase() === 'from')) {
    return { verdict: 'permerror', domain: sig.domain };
  }
  // RFC 6376 §3.5: a signature whose expiration (x=, epoch seconds) has passed is
  // stale — treat it as a failure so an old signed message cannot be replayed forever.
  const xTag = sig.tags.get('x');
  if (xTag !== undefined && /^\d+$/.test(xTag) && Math.floor(Date.now() / 1000) > Number(xTag)) {
    return { verdict: 'fail', domain: sig.domain };
  }

  const headerCanon: HeaderCanon = (sig.tags.get('c') ?? '').split('/')[0] === 'relaxed' ? 'relaxed' : 'simple';
  const bodyCanon = bodyCanonOf(sig);
  const algo = hashAlgoOf(sig);
  // RFC 8301: rsa-sha1 (and any sha1 body hash) MUST be treated as a verification failure.
  // SHA-1 is broken — chosen-prefix collisions are practical ("SHA-1 is a Shambles", 2020) —
  // so a sha1 DKIM must never yield a pass that then flows into DMARC alignment (audit run-3).
  if (algo === 'sha1') return { verdict: 'fail', domain: sig.domain };
  const lTag = sig.tags.get('l');
  const lengthLimit = lTag !== undefined && /^\d+$/.test(lTag) ? Number(lTag) : undefined;

  // RFC 6376 §3.5: l= must not exceed the canonicalised body length. An overlong l=
  // is malformed and (with the append caveat of §8.2) a red flag; the receive path
  // must apply the same check the body-hash verifier does, not honour it blindly.
  if (lengthLimit !== undefined && lengthLimit > memo.canonicalized(bodyCanon).length) {
    return { verdict: 'fail', domain: sig.domain };
  }

  // Step 1 (RFC 6376 §6.1.3): the body hash must match, else the body was altered.
  if (memo.digest(bodyCanon, algo, lengthLimit) !== sig.bodyHash) {
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
  // RFC 6376 §5.4.2: select each h= field from the bottom of the header block up, consuming
  // instances — so an oversigned name binds the absence of a further instance (a prepended
  // From then fails to verify). The shared selector is the SAME one the signer hashes through.
  const signedFields = selectSignedFields(headers, sig.signedHeaders);
  const input = buildSigningInput(signedFields, sigValue, headerCanon);

  let ok: boolean;
  try {
    if (keyRecord.keyType === 'ed25519') {
      ok = verifyEd25519(input, sig.signature, importEd25519PublicKey(Buffer.from(keyRecord.publicKey, 'base64')));
    } else {
      const publicKey = createPublicKey({ key: Buffer.from(keyRecord.publicKey, 'base64'), format: 'der', type: 'spki' });
      ok = verifySignature(input, sig.signature, publicKey, 'RSA-SHA256'); // rsa-sha1 rejected above (RFC 8301)
    }
  } catch {
    return { verdict: 'permerror', domain: sig.domain };
  }
  return { verdict: ok ? 'pass' : 'fail', domain: sig.domain };
}
