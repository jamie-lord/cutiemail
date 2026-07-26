/**
 * A DKIM-Signature header tag-list parser (RFC 6376 §3.5), with switchable defects.
 *
 * Parses the "v=1; a=rsa-sha256; d=...; s=...; h=...; bh=...; b=..." tag-list into
 * its fields and applies the structural gates that decide whether verification may
 * even begin: no duplicate tags, all required tags present, unknown tags ignored.
 * The cryptographic verification (RSA/Ed25519 over the §3.4 canonicalized output)
 * is a later increment — this is the parse gate in front of it.
 *
 * Tag values are handled per §3.5: whitespace around them is stripped, but this
 * parser does not otherwise alter values. Bytes in; structured out.
 */

const REQUIRED_TAGS = ['v', 'a', 'b', 'bh', 'd', 's', 'h'] as const;

export interface DkimSignature {
  readonly valid: boolean;
  readonly tags: ReadonlyMap<string, string>;
  readonly version: string | null;
  readonly algorithm: string | null; // a=
  readonly signature: string | null; // b=
  readonly bodyHash: string | null; // bh=
  readonly domain: string | null; // d=
  readonly selector: string | null; // s=
  readonly signedHeaders: readonly string[]; // h=, colon-separated
  readonly anomalies: readonly string[];
}

export interface DkimSignatureDefects {
  /** Merge duplicate tags (last wins) instead of invalidating the list. Violates R-6376-3.5-a. */
  readonly acceptDuplicateTags?: boolean;
  /** Let an unrecognised tag invalidate the signature. Violates R-6376-3.5-b. */
  readonly failOnUnknownTag?: boolean;
  /** Tolerate a missing required tag. Violates R-6376-3.5-c. */
  readonly acceptMissingRequiredTag?: boolean;
  /** Accept a "v=" other than 1. Violates R-6376-6.1.1-b. */
  readonly acceptAnyVersion?: boolean;
  /** Accept an "a=" naming an algorithm that does not exist. Violates R-6376-6.1.1-a. */
  readonly acceptUnknownAlgorithm?: boolean;
}

const KNOWN_TAGS = new Set(['v', 'a', 'b', 'bh', 'c', 'd', 'h', 'i', 'l', 'q', 's', 't', 'x', 'z']);

/**
 * The one DKIM version that exists (RFC 6376 §3.5 "v="). §6.1.1 makes anything else a PERMFAIL
 * (incompatible version) rather than something to verify optimistically: a different version means
 * the header field follows rules this code does not know, so a signature that "verifies" under our
 * reading of v=2 says nothing about what the signer computed.
 */
const DKIM_VERSION = '1';

/**
 * Every signing algorithm this project can verify, by its "a=" name: rsa-sha1 and rsa-sha256
 * (RFC 6376 §3.3) plus ed25519-sha256 (RFC 8463 §3).
 *
 * rsa-sha1 is deliberately IN the set. It is a real algorithm that RFC 8301 §3.1 then makes a
 * verification FAILURE, and the two answers are different: the signature is well formed and
 * refused on cryptographic grounds (fail), not malformed (permerror). Dropping it here would
 * collapse that distinction and bypass the dedicated SHA-1 gate in the verifier.
 *
 * The refusal that matters is the OPEN END. Reading "a=" by suffix — anything ending "sha1" is
 * SHA-1, everything else SHA-256 — means an unrecognised name like `a=rsa-sha999` is silently
 * verified as rsa-sha256. The signer said it computed one thing and the verifier computed another,
 * which is precisely the signer/verifier disagreement §6.1.1's "meticulously" exists to prevent,
 * and it is the direction that hands out a PASS rather than withholding one.
 */
const KNOWN_ALGORITHMS = new Set(['rsa-sha1', 'rsa-sha256', 'ed25519-sha256']);

export function parseDkimSignature(header: Buffer, defects: DkimSignatureDefects = {}): DkimSignature {
  const line = header.toString('latin1').trim();
  const parts = line.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  const tags = new Map<string, string>();
  const counts = new Map<string, number>();
  const anomalies: string[] = [];
  let valid = true;

  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
    tags.set(name, value); // last-wins in the map; duplicate detection uses `counts`
  }

  // R-6376-3.5-a: a duplicate tag invalidates the whole list.
  for (const [name, n] of counts) {
    if (n > 1) {
      anomalies.push(`duplicate-tag:${name}`);
      if (defects.acceptDuplicateTags !== true) valid = false;
    }
  }

  // R-6376-3.5-b: unknown tags are ignored (not fatal) unless the defect makes them so.
  for (const name of counts.keys()) {
    if (!KNOWN_TAGS.has(name)) {
      anomalies.push(`unknown-tag-ignored:${name}`);
      if (defects.failOnUnknownTag === true) valid = false;
    }
  }

  // R-6376-3.5-c: all required tags must be present.
  for (const req of REQUIRED_TAGS) {
    if (!tags.has(req)) {
      anomalies.push(`missing-required-tag:${req}`);
      if (defects.acceptMissingRequiredTag !== true) valid = false;
    }
  }

  // R-6376-6.1.1-b: a "v=" this specification does not define is PERMFAIL (incompatible version).
  // Checked only when the tag is present; its absence is already the missing-required-tag failure
  // above, and reporting both for one signature would say the version is wrong when it is absent.
  const vTag = tags.get('v');
  if (vTag !== undefined && vTag !== DKIM_VERSION) {
    anomalies.push(`bad-version:${vTag}`);
    if (defects.acceptAnyVersion !== true) valid = false;
  }

  // R-6376-6.1.1-a: an "a=" naming an algorithm that does not exist is an unexpected value, and
  // must make the field ignored rather than be resolved to whichever algorithm happens to be the
  // default. See KNOWN_ALGORITHMS for why rsa-sha1 stays in the set.
  const aTag = tags.get('a');
  if (aTag !== undefined && !KNOWN_ALGORITHMS.has(aTag.toLowerCase())) {
    anomalies.push(`unknown-algorithm:${aTag}`);
    if (defects.acceptUnknownAlgorithm !== true) valid = false;
  }

  const h = tags.get('h');
  return {
    valid,
    tags,
    version: tags.get('v') ?? null,
    algorithm: tags.get('a') ?? null,
    signature: tags.get('b') ?? null,
    bodyHash: tags.get('bh') ?? null,
    domain: tags.get('d') ?? null,
    selector: tags.get('s') ?? null,
    signedHeaders: h === undefined ? [] : h.split(':').map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0),
    anomalies,
  };
}

/** True if any anomaly starts with `prefix` (e.g. "duplicate-tag", "missing-required-tag"). */
export function hasSignatureAnomaly(sig: DkimSignature, prefix: string): boolean {
  return sig.anomalies.some((a) => a === prefix || a.startsWith(`${prefix}:`));
}
