/**
 * MX resolution for outbound delivery (RFC 5321 §5.1), with switchable defects.
 *
 * Given a recipient domain, produce the ordered list of hosts to attempt delivery
 * to: the MX records sorted by increasing preference, or — if there are no MX
 * records — the domain itself as an implicit MX (if it has an address record). DNS
 * is injected (a resolver interface), so the ordering logic is testable without a
 * network, exactly like the SPF/DMARC evaluators.
 *
 * These §5.1 requirements bind the client and are `not-testable` from the receiver
 * suite's seat; this reference resolver makes them checkable (cited read-only in the
 * corpus).
 */

export interface MxRecord {
  readonly host: string;
  readonly preference: number;
}

export interface DnsResolver {
  /** MX records for a domain (empty if none). */
  mx(domain: string): readonly MxRecord[];
  /** True if the domain has an address (A/AAAA) record. */
  hasAddress(domain: string): boolean;
}

export interface MxDefects {
  /** Do not sort by preference (use DNS order). Violates R-5321-5.1-n. */
  readonly ignorePreference?: boolean;
  /** Fall back to the domain's address record even when MX records exist. Violates R-5321-5.1-g. */
  readonly useAddressWhenMxPresent?: boolean;
  /** Keep DNS order within an equal-preference tier (never randomize). Violates R-5321-5.1-o. */
  readonly noEqualPreferenceShuffle?: boolean;
}

export interface MxResult {
  /** Hosts to attempt, in delivery order. */
  readonly hosts: readonly string[];
  readonly anomalies: readonly string[];
}

/**
 * Sort by increasing preference, then Fisher-Yates shuffle each equal-preference tier in place.
 * R-5321-5.1-o (MUST): when several MXes share a preference "the sender-SMTP MUST randomize them
 * to spread the load". `rng` is injected so the corpus can pin the statistics deterministically;
 * production uses Math.random.
 */
function orderByPreference(records: readonly MxRecord[], rng: () => number): MxRecord[] {
  const byPref = [...records].sort((a, b) => a.preference - b.preference);
  let i = 0;
  while (i < byPref.length) {
    let j = i;
    while (j < byPref.length && byPref[j]!.preference === byPref[i]!.preference) j++;
    // Shuffle the [i, j) tier (all sharing byPref[i].preference).
    for (let k = j - 1; k > i; k--) {
      const r = i + Math.floor(rng() * (k - i + 1));
      const tmp = byPref[k]!;
      byPref[k] = byPref[r]!;
      byPref[r] = tmp;
    }
    i = j;
  }
  return byPref;
}

/**
 * Resolve the ordered delivery hosts for a recipient domain. `rng` seeds the equal-preference
 * randomization (R-5321-5.1-o); it defaults to Math.random and is injected only by tests.
 */
export function resolveMxHosts(domain: string, dns: DnsResolver, defects: MxDefects = {}, rng: () => number = Math.random): MxResult {
  const mx = dns.mx(domain);
  const anomalies: string[] = [];

  // RFC 7505 null MX: a single "MX 0 ." record is an explicit statement that the domain
  // accepts NO mail. Node's resolver surfaces the root target as an EMPTY host (''), not the
  // literal '.', so normalise both to the reserved '.' sentinel the caller bounces on. Left
  // as '' it would reach net.connect({host:''}), which dials localhost — an RFC 7505 violation
  // AND a loopback SSRF/mail-loop.
  if (mx.length === 1 && (mx[0]!.host === '' || mx[0]!.host === '.')) {
    return { hosts: ['.'], anomalies: ['null-mx'] };
  }

  if (mx.length > 0) {
    // R-5321-5.1-n: sort by increasing preference; R-5321-5.1-o: randomize within a tier.
    // The ignorePreference defect uses raw DNS order (no sort, no shuffle); the
    // noEqualPreferenceShuffle defect sorts but leaves each tier in DNS order.
    const ordered =
      defects.ignorePreference === true
        ? [...mx]
        : defects.noEqualPreferenceShuffle === true
          ? [...mx].sort((a, b) => a.preference - b.preference)
          : orderByPreference(mx, rng);
    const hosts = ordered.map((r) => r.host);
    // R-5321-5.1-g: with MX present, do NOT use the domain's own address record.
    if (defects.useAddressWhenMxPresent === true && dns.hasAddress(domain)) hosts.push(domain);
    return { hosts, anomalies };
  }

  // No MX: the domain itself is an implicit MX at preference 0, if it has an address.
  if (dns.hasAddress(domain)) return { hosts: [domain], anomalies };
  anomalies.push('no-mx-no-address');
  return { hosts: [], anomalies };
}
