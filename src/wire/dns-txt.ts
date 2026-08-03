/**
 * Reassemble a DNS TXT record's character-strings into one value.
 *
 * A TXT record is a sequence of one or more character-strings, each at most 255 octets
 * (RFC 1035 §3.3.14). A value longer than 255 octets is therefore published as several strings,
 * and a reader MUST concatenate them WITH NO added separator. Three protocols this server speaks
 * carry the identical rule, and Node's `resolveTxt` hands every record back as an array of chunks,
 * so the join is unavoidable:
 *
 *   - MTA-STS (RFC 8461 §3.1): "If the resulting TXT record contains multiple strings, then the
 *     record MUST be treated as if those strings are concatenated without adding spaces." (R-8461-3.1-c)
 *   - SPF (RFC 7208 §3.3): multiple strings "are concatenated together without adding spaces."
 *   - DKIM public-key records (RFC 6376 §3.6.2.2): the strings are concatenated.
 *
 * Joining with a SPACE instead — the natural mistake, since the chunks arrive as an array whose
 * `.join()` default separator is a comma and whose obvious "readable" fix is `join(' ')` — silently
 * corrupts whichever field straddles a 255-octet boundary. The record then fails to parse, turning
 * STS enforcement (or a DKIM key lookup, or an SPF evaluation) off for exactly the domains whose
 * records are long enough to be split, and for no others. That is why this one-liner is worth a
 * named, tested home rather than an inline `chunks.join('')` at each call site.
 */
export function joinTxtRecord(chunks: readonly string[]): string {
  return chunks.join('');
}
