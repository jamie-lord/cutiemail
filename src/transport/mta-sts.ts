/**
 * An MTA-STS policy parser and MX matcher (RFC 8461 §3.2/§4.1), with switchable
 * defects.
 *
 * Parses the key/value policy file a domain publishes and decides whether a
 * candidate MX host is permitted by it. The security-critical part is MX matching:
 * a wildcard may cover only the single left-most label, so "*.example.com" must
 * accept "mail.example.com" but reject "evil.attacker.example.com" and the bare
 * "example.com". DNS/HTTPS fetching of the policy is out of scope — this is the
 * pure parse + match logic.
 */

export type StsMode = 'enforce' | 'testing' | 'none';

const MODES: readonly string[] = ['enforce', 'testing', 'none'];

export interface StsPolicy {
  readonly valid: boolean;
  readonly version: string | null;
  readonly mode: StsMode | null;
  readonly mx: readonly string[];
  readonly maxAge: number | null;
  readonly anomalies: readonly string[];
}

export interface StsParseDefects {
  /** Accept a version other than "STSv1". Violates R-8461-3.2-a. */
  readonly acceptAnyVersion?: boolean;
  /** Accept a mode outside {enforce,testing,none}. Violates R-8461-3.2-b. */
  readonly acceptUnknownMode?: boolean;
}

export function parseStsPolicy(policy: Buffer, defects: StsParseDefects = {}): StsPolicy {
  const lines = policy.toString('latin1').split(/\r?\n/);
  const anomalies: string[] = [];
  let version: string | null = null;
  let mode: StsMode | null = null;
  const mx: string[] = [];
  let maxAge: number | null = null;

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'version':
        version = value;
        break;
      case 'mode':
        mode = MODES.includes(value) ? (value as StsMode) : null;
        if (!MODES.includes(value)) anomalies.push('unknown-mode');
        break;
      case 'mx':
        if (value.length > 0) mx.push(value.toLowerCase());
        break;
      case 'max_age': {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) maxAge = n;
        break;
      }
      default:
        break; // unknown fields ignored
    }
  }

  let valid = true;
  if (version !== 'STSv1' && defects.acceptAnyVersion !== true) {
    valid = false;
    anomalies.push('bad-version');
  }
  if (mode === null && defects.acceptUnknownMode !== true) {
    valid = false;
    // 'unknown-mode' already pushed above if a value was present.
    if (!anomalies.includes('unknown-mode')) anomalies.push('missing-mode');
  }

  return { valid, version, mode, mx, maxAge, anomalies };
}

export interface MxMatchDefects {
  /** Let a wildcard span more than the single left-most label. Violates R-8461-4.1-a. */
  readonly wildcardMatchesMultipleLabels?: boolean;
}

/** Does the candidate MX host match the pattern? Wildcard covers exactly one left-most label. */
export function mxMatches(pattern: string, host: string, defects: MxMatchDefects = {}): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (!p.startsWith('*.')) return p === h;

  const suffix = p.slice(1); // ".example.com"
  if (!h.endsWith(suffix)) return false;
  const labelPart = h.slice(0, h.length - suffix.length); // the bit before the suffix
  if (labelPart.length === 0) return false; // "*.example.com" must not match "example.com"
  if (defects.wildcardMatchesMultipleLabels === true) return true;
  // Exactly one left-most label: no dot inside the matched part.
  return !labelPart.includes('.');
}

/** Is `host` permitted by the policy's mx patterns? */
export function mxAllowed(policy: StsPolicy, host: string, defects: MxMatchDefects = {}): boolean {
  return policy.mx.some((pattern) => mxMatches(pattern, host, defects));
}
