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
}

const KNOWN_TAGS = new Set(['v', 'a', 'b', 'bh', 'c', 'd', 'h', 'i', 'l', 'q', 's', 't', 'x', 'z']);

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
