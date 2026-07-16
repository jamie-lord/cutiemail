/**
 * A DKIM public-key record parser (RFC 6376 §3.6.1), with switchable defects.
 *
 * Parses the "v=DKIM1; k=rsa|ed25519; p=<base64>" TXT record a verifier fetches
 * from DNS, applying the version-discard and revocation rules. DNS lookup itself is
 * out of scope — this is the record parse. The extracted key type + p= feed the
 * RSA (dkim-verify) or Ed25519 (dkim-ed25519) verification.
 */

export type DkimKeyType = 'rsa' | 'ed25519';

export interface DkimKeyRecord {
  readonly valid: boolean;
  readonly version: string | null;
  /** Key type; defaults to "rsa". Unknown types are kept but the record is not usable. */
  readonly keyType: string;
  /** The base64 public-key data (p=), or null if absent/revoked. */
  readonly publicKey: string | null;
  /** True when p= is present but empty — the key is revoked. */
  readonly revoked: boolean;
  readonly anomalies: readonly string[];
}

export interface DkimKeyRecordDefects {
  /** Accept a version other than DKIM1. Violates R-6376-3.6.1-a. */
  readonly acceptAnyVersion?: boolean;
  /** Treat an empty p= (revoked) as a usable key. Violates R-6376-3.6.1-b. */
  readonly treatEmptyPAsValid?: boolean;
}

export function parseDkimKeyRecord(record: Buffer, defects: DkimKeyRecordDefects = {}): DkimKeyRecord {
  const line = record.toString('latin1').trim();
  const parts = line.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  const tags = new Map<string, string>();
  const order: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!tags.has(name)) order.push(name);
    tags.set(name, value);
  }

  const anomalies: string[] = [];
  let wellFormed = true;

  // R-6376-3.6.1-a: if v= is present it must be DKIM1 and first.
  const version = tags.get('v') ?? null;
  if (version !== null) {
    if (version !== 'DKIM1' && defects.acceptAnyVersion !== true) {
      wellFormed = false;
      anomalies.push('bad-version');
    }
    if (order[0] !== 'v') {
      wellFormed = false;
      anomalies.push('v-not-first');
    }
  }

  const keyType = tags.get('k') ?? 'rsa'; // default rsa

  // R-6376-3.6.1-b: p= REQUIRED; an empty p= is a revocation tombstone.
  const p = tags.get('p');
  let revoked = false;
  let publicKey: string | null = null;
  if (p === undefined) {
    wellFormed = false;
    anomalies.push('missing-p');
  } else if (p === '') {
    revoked = true;
    anomalies.push('key-revoked');
  } else {
    publicKey = p;
  }

  // `valid` = usable for verification. A revoked key is usable ONLY under the
  // defect (the whole point of the negative control); a malformed record never is.
  const usable = revoked ? defects.treatEmptyPAsValid === true : wellFormed && publicKey !== null;

  return { valid: usable, version, keyType, publicKey, revoked, anomalies };
}
