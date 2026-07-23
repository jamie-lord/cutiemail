/**
 * Inbound ARC verification — the Validator Actions of RFC 8617 §5.2.
 *
 * Composes the vector-pinned crypto: parse the ARC header Sets from the message, run the
 * structure check (arc.ts, §5.2 step 3), verify the most-recent ARC-Message-Signature
 * (arc-ams + dkim body/header hash), then verify every ARC-Seal from N down to 1
 * (arc-seal). The output is a Chain Validation Status — "none" (no chain), "pass"
 * (structurally sound and every seal + the newest AMS verify) or "fail" — plus the
 * sealing domains, so the delivery path can make a LOCAL trust decision (RFC 8617 §5.2:
 * acting on ARC is local policy; a cv=pass chain is only meaningful if you trust the
 * sealer — see arc-inbound integration + ADR).
 *
 * §5.2.1: all ARC failures are PERMANENT — a DNS miss, a parse error, or a bad signature
 * all collapse to cv=fail (never temperror), and a fail is treated as no chain at all.
 * Bytes, never strings: body hashing and canonicalization run on the exact stored octets.
 */

import { parseMessage } from '../message/parse.ts';
import { validateArcChainStructure, type ArcSet, type ChainValidation } from '../auth/arc.ts';
import { computeBodyHash, canonicalizedBodyLength } from '../crypto/dkim-bodyhash.ts';
import { buildAmsInput } from '../crypto/arc-ams.ts';
import { buildSealInput, verifySeal, type ArcSetHeaders } from '../crypto/arc-seal.ts';
import { verifySignature, selectSignedFields } from '../crypto/dkim-verify.ts';
import { verifyEd25519, importEd25519PublicKey } from '../crypto/dkim-ed25519.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { createPublicKey } from 'node:crypto';
import type { DkimKeyResolver } from './dkim-inbound.ts';

export interface ArcOutcome {
  /** The Chain Validation Status included in Authentication-Results (arc=). */
  readonly cv: ChainValidation;
  /** N — the number of ARC Sets (0 when cv=none). */
  readonly instances: number;
  /** The d= of the ARC-Seal at each instance, in order 1..N. */
  readonly sealDomains: readonly string[];
  /** The d= of the outermost (most recent) ARC-Seal — the hop that forwarded to us. */
  readonly outermostSealer: string | null;
  /** Diagnostic notes (why a chain failed, etc.). */
  readonly anomalies: readonly string[];
}

const NONE: ArcOutcome = { cv: 'none', instances: 0, sealDomains: [], outermostSealer: null, anomalies: [] };

/** Extract the value of `tag` from an ARC/DKIM tag-list value; undefined if absent. */
function tagValue(value: string, tag: string): string | undefined {
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === tag) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A base64 tag (b=, bh=, p=) may carry folding WSP; the signature is over the WSP-free form. */
const stripWsp = (s: string): string => s.replace(/[ \t\r\n]/g, '');

/** Unfold a header value (drop the CRLF of each fold) for tag parsing + relaxed canon input. */
const unfold = (s: string): string => s.replace(/\r\n(?=[ \t])/g, '');

interface RawArc {
  readonly instance: number;
  aar?: string;
  ams?: string;
  as?: string;
}

async function resolvePublicKey(
  d: string | undefined,
  s: string | undefined,
  resolveKey: DkimKeyResolver,
): Promise<{ keyType: 'rsa' | 'ed25519'; pub: string } | null> {
  if (d === undefined || s === undefined) return null;
  let bytes: Buffer | null;
  try {
    bytes = await resolveKey(d, s);
  } catch {
    return null; // §5.2.1: a DNS failure is a permanent ARC failure, not a retry
  }
  if (bytes === null) return null;
  const rec = parseDkimKeyRecord(bytes);
  if (!rec.valid || rec.publicKey === null) return null;
  return { keyType: rec.keyType === 'ed25519' ? 'ed25519' : 'rsa', pub: rec.publicKey };
}

/** Verify one signature (AMS or AS input) with a resolved key. */
function verifyWithKey(input: Buffer, b: string, key: { keyType: 'rsa' | 'ed25519'; pub: string }): boolean {
  try {
    if (key.keyType === 'ed25519') {
      return verifyEd25519(input, b, importEd25519PublicKey(Buffer.from(key.pub, 'base64')));
    }
    const publicKey = createPublicKey({ key: Buffer.from(key.pub, 'base64'), format: 'der', type: 'spki' });
    // RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of less than 1024
    // bits as valid." ARC shares DKIM's crypto, so it shares the floor: a weak-key AMS or seal
    // is invalid, which (all ARC failures being permanent, §5.2.1) collapses the chain to cv=fail.
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) return false;
    return verifySignature(input, b, publicKey, 'RSA-SHA256');
  } catch {
    return false;
  }
}

/** Verify the most-recent ARC-Message-Signature (§5.2 step 4) over the message body+headers. */
async function verifyNewestAms(
  amsValue: string,
  headers: ReturnType<typeof parseMessage>['headers'],
  body: Buffer,
  resolveKey: DkimKeyResolver,
): Promise<boolean> {
  const ams = unfold(amsValue);
  const bh = tagValue(ams, 'bh');
  const b = tagValue(ams, 'b');
  const h = tagValue(ams, 'h');
  const d = tagValue(ams, 'd');
  const s = tagValue(ams, 's');
  if (bh === undefined || b === undefined || h === undefined || d === undefined || s === undefined) return false;

  // The AMS must sign From — mirror the DKIM path (dkim-inbound rejects a From-omitting
  // signature). ARC-Seal covers only the ARC header sets, not From, so an AMS whose h= omits
  // From would let a cv=pass chain carry an unprotected (spoofable) sender that the ARC rescue
  // then trusts past a p=reject DMARC failure.
  if (!h.split(':').some((n) => n.trim().toLowerCase() === 'from')) return false;

  const c = tagValue(ams, 'c') ?? 'simple/simple';
  const headerCanon = c.split('/')[0] === 'relaxed' ? 'relaxed' : 'simple';
  const bodyCanon = c.split('/')[1] === 'relaxed' ? 'relaxed' : 'simple';
  const lTag = tagValue(ams, 'l');
  const lengthLimit = lTag !== undefined && /^\d+$/.test(lTag) ? Number(lTag) : undefined;
  // RFC 6376 §8.2 partial-body caveat, mirroring the DKIM path (dkim-inbound rejects any l= that is
  // not the full canonicalised body length): an AMS `l=` covering only a prefix lets an attacker
  // append arbitrary body content that the newest AMS — and thus a trusted-sealer cv=pass rescue —
  // still accepts. Require full-body coverage; cutiemail never emits l= so this costs nothing.
  if (lengthLimit !== undefined && lengthLimit !== canonicalizedBodyLength(body, bodyCanon)) return false;

  // Step 1: the body hash must match (the body was not altered past what the AMS covers).
  if (computeBodyHash(body, bodyCanon, 'sha256', lengthLimit) !== stripWsp(bh)) return false;

  // Step 2: build the header-hash input over h= plus the AMS field (b= emptied) and verify.
  // Same RFC 6376 §5.4.2 bottom-up, instance-consuming selection as DKIM (shared selector) —
  // so an oversigned AMS field is verified soundly and there is one header-selection code path.
  const signedFields = selectSignedFields(headers, h.split(':'));
  const input = buildAmsInput(signedFields, ams, headerCanon);

  const key = await resolvePublicKey(d, s, resolveKey);
  if (key === null) return false;
  return verifyWithKey(input, stripWsp(b), key);
}

/**
 * Run the RFC 8617 §5.2 Validator Actions over a raw message. Never throws; any error
 * yields cv=fail (§5.2.1). `resolveKey` fetches an ARC public key (DKIM-format TXT at
 * s._domainkey.d) — reuse the DKIM resolver.
 */
export async function verifyArc(raw: Buffer, resolveKey: DkimKeyResolver): Promise<ArcOutcome> {
  const { headers, body } = parseMessage(raw);

  // 1. Collect ARC Sets, grouped by instance.
  const byInstance = new Map<number, RawArc>();
  for (const hdr of headers) {
    const name = hdr.name.toString('latin1').trim().toLowerCase();
    const kind = name === 'arc-authentication-results' ? 'aar' : name === 'arc-message-signature' ? 'ams' : name === 'arc-seal' ? 'as' : null;
    if (kind === null) continue;
    const value = hdr.value.toString('latin1');
    const iRaw = tagValue(unfold(value), 'i');
    if (iRaw === undefined || !/^\d+$/.test(iRaw.trim())) return { ...NONE, cv: 'fail', anomalies: ['arc-header-missing-instance'] };
    const instance = Number(iRaw.trim());
    let set = byInstance.get(instance);
    if (set === undefined) {
      set = { instance };
      byInstance.set(instance, set);
    }
    // A duplicate of the same field in one set is a malformed chain (§5.2 step 3.A).
    if (set[kind] !== undefined) return { ...NONE, cv: 'fail', instances: byInstance.size, anomalies: [`duplicate-${kind}:${instance}`] };
    set[kind] = value;
  }

  if (byInstance.size === 0) return NONE;
  const n = Math.max(...byInstance.keys());
  // §5.2 step 1: at most 50 Sets; also cap N so a huge i= can't index wildly.
  if (byInstance.size > 50 || n > 50) return { ...NONE, cv: 'fail', instances: byInstance.size, anomalies: ['too-many-arc-sets'] };

  // Assemble the raw header values per set (for the seal signing input + structure check).
  const setHeaders: ArcSetHeaders[] = [];
  const structural: ArcSet[] = [];
  for (const [instance, s] of byInstance) {
    const asCv = s.as !== undefined ? (tagValue(unfold(s.as), 'cv') ?? '').toLowerCase() : '';
    const cv: ChainValidation = asCv === 'pass' ? 'pass' : asCv === 'none' ? 'none' : asCv === 'fail' ? 'fail' : 'fail';
    structural.push({ instance, cv, hasAAR: s.aar !== undefined, hasAMS: s.ams !== undefined, hasAS: s.as !== undefined });
    setHeaders.push({ instance, aar: unfold(s.aar ?? ''), ams: unfold(s.ams ?? ''), as: unfold(s.as ?? '') });
  }

  // §5.2 step 2: if the highest-instance Set's cv is "fail", the chain fails.
  const newest = byInstance.get(n)!;
  if (newest.as === undefined) return { ...NONE, cv: 'fail', instances: byInstance.size, anomalies: ['newest-set-missing-seal'] };
  if ((tagValue(unfold(newest.as), 'cv') ?? '').toLowerCase() === 'fail') {
    return { ...NONE, cv: 'fail', instances: byInstance.size, anomalies: ['newest-cv-fail'] };
  }

  // §5.2 step 3: structural validity (continuous 1..N, one of each field, cv discipline).
  const structure = validateArcChainStructure(structural);
  if (structure.status !== 'pass') {
    return { ...NONE, cv: 'fail', instances: byInstance.size, anomalies: structure.anomalies };
  }

  const sealDomains = [...setHeaders].sort((a, b) => a.instance - b.instance).map((s) => tagValue(s.as, 'd') ?? '');
  const outermostSealer = tagValue(setHeaders.find((s) => s.instance === n)!.as, 'd') ?? null;
  const fail = (why: string): ArcOutcome => ({ cv: 'fail', instances: byInstance.size, sealDomains, outermostSealer, anomalies: [why] });

  // §5.2 step 4: the most recent AMS must verify.
  if (newest.ams === undefined || !(await verifyNewestAms(newest.ams, headers, body, resolveKey))) return fail('newest-ams-invalid');

  // §5.2 step 6: every ARC-Seal, from N down to 1, must verify.
  for (let m = n; m >= 1; m--) {
    const set = setHeaders.find((s) => s.instance === m)!;
    const key = await resolvePublicKey(tagValue(set.as, 'd'), tagValue(set.as, 's'), resolveKey);
    const b = tagValue(set.as, 'b');
    if (key === null || b === undefined || !verifySeal(buildSealInput(setHeaders, m), stripWsp(b), key.keyType, key.pub)) {
      return fail(`seal-invalid:${m}`);
    }
  }

  // §5.2 step 7: structurally sound, newest AMS + every seal verified → pass.
  return { cv: 'pass', instances: byInstance.size, sealDomains, outermostSealer, anomalies: [] };
}
