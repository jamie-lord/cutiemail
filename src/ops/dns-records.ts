/**
 * The DNS record plan for a cutie-mail deployment (backlog B1).
 *
 * A pure function from deployment parameters to the zone records an operator must
 * publish — MX, A/AAAA, SPF, the DKIM public key, DMARC — plus the out-of-band
 * notes (reverse DNS) that are records in someone else's zone. The evidence behind
 * this feature (docs/BACKLOG.md): hand-assembling the deliverability DNS cluster is
 * where first-time operators fail, and generating the records from the same config
 * the server runs on removes the transcription step entirely.
 *
 * Deterministic: same parameters, same output, so a re-run is diffable against
 * what is already published. No timestamps, no randomness.
 */

export interface DnsPlanParams {
  /** The mail domain — the right-hand side of the addresses this server hosts. */
  readonly domain: string;
  /** The machine's FQDN — the MX exchange and the A/AAAA + PTR target. */
  readonly mailHost: string;
  /** The box's public addresses (v4 and/or v6). Empty = SPF falls back to `mx`. */
  readonly ips: readonly string[];
  readonly dkim: {
    readonly selector: string;
    /** The full TXT value ("v=DKIM1; k=...; p=..."), derived from the private key. */
    readonly txtValue: string;
  };
  /** DMARC policy to request of receivers. Quarantine is the sane modern default. */
  readonly dmarcPolicy: 'none' | 'quarantine' | 'reject';
}

export interface DnsRecord {
  /** Fully-qualified owner name, without the trailing dot (added at render). */
  readonly name: string;
  readonly type: 'A' | 'AAAA' | 'MX' | 'TXT';
  /** The record data. TXT values are the raw value; quoting/chunking is render-time. */
  readonly value: string;
  readonly comment: string;
}

const isV6 = (ip: string): boolean => ip.includes(':');

/** The records to publish, in the order an operator would sensibly enter them. */
export function dnsRecordsFor(p: DnsPlanParams): readonly DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const ip of p.ips) {
    records.push({
      name: p.mailHost,
      type: isV6(ip) ? 'AAAA' : 'A',
      value: ip,
      comment: 'the machine itself — where clients and other mail servers connect',
    });
  }
  records.push({
    name: p.domain,
    type: 'MX',
    value: `10 ${p.mailHost}.`,
    comment: `mail for @${p.domain} is delivered to ${p.mailHost}`,
  });
  // SPF: exactly the addresses this box sends from, hard-fail everything else.
  // With no --ip given, `mx` delegates to the MX's A/AAAA — correct for the
  // self-contained single-box deployment where the MX host IS the sender.
  const mechanisms = p.ips.length > 0 ? p.ips.map((ip) => (isV6(ip) ? `ip6:${ip}` : `ip4:${ip}`)).join(' ') : 'mx';
  records.push({
    name: p.domain,
    type: 'TXT',
    value: `v=spf1 ${mechanisms} -all`,
    comment: 'SPF: only this machine may send mail for the domain (hard fail for all others)',
  });
  records.push({
    name: `${p.dkim.selector}._domainkey.${p.domain}`,
    type: 'TXT',
    value: p.dkim.txtValue,
    comment: 'DKIM public key — verifiers fetch this to check our signatures',
  });
  records.push({
    name: `_dmarc.${p.domain}`,
    type: 'TXT',
    value: `v=DMARC1; p=${p.dmarcPolicy}`,
    comment: `DMARC: ask receivers to ${p.dmarcPolicy === 'none' ? 'monitor only' : p.dmarcPolicy} mail that fails aligned SPF/DKIM`,
  });
  return records;
}

/**
 * Split a TXT value into <=255-octet chunks — a single DNS character-string holds
 * at most 255 octets, so longer values (an RSA DKIM key is ~400) are published as
 * adjacent quoted strings that verifiers concatenate (RFC 7208 §3.3 / RFC 6376).
 */
export function chunkTxt(value: string): readonly string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
  return chunks;
}

/** Render the plan as an annotated zone-file fragment. */
export function renderZone(records: readonly DnsRecord[]): string {
  const lines: string[] = [];
  for (const r of records) {
    lines.push(`; ${r.comment}`);
    const value = r.type === 'TXT' ? chunkTxt(r.value).map((c) => `"${c}"`).join(' ') : r.value;
    lines.push(`${r.name}.\tIN\t${r.type}\t${value}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** The out-of-band steps that are not records in the operator's own zone. */
export function renderNotes(p: DnsPlanParams): string {
  const lines: string[] = [];
  lines.push('; Not zone records, but required for deliverability:');
  if (p.ips.length > 0) {
    for (const ip of p.ips) {
      lines.push(`;  - reverse DNS (PTR): set ${ip} -> ${p.mailHost} at your hosting provider.`);
    }
    lines.push(';    Forward-confirmed rDNS (PTR matching the A/AAAA above) is checked by big receivers.');
  } else {
    lines.push(`;  - reverse DNS (PTR): set the box's IP -> ${p.mailHost} at your hosting provider.`);
    lines.push(';  - re-run with --ip <address> to pin SPF to the exact address instead of `mx`.');
  }
  return lines.join('\n');
}
