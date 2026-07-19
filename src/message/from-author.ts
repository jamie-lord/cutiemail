/**
 * The RFC 5322 §3.4 author of a message's From header, extracted the way a compliant MUA
 * DISPLAYS it — not with a naive first-`<...>` match. This one extractor is the single
 * source of truth for "who is the From", shared by inbound DMARC alignment
 * (server/dmarc-inbound.ts) and outbound submission sender-authorization (ADR 0015). If the
 * two parsed From differently, an address the send-as gate blessed could be a different one
 * from the address DMARC aligns — the divergence-by-two-implementations bug this project
 * avoids on principle.
 *
 * The hard case both callers must survive is the display-name decoy:
 *   From: "x <a@evil.com>" <victim@bank.com>
 * A naive first-`<>` reads a@evil.com while the client shows victim@bank.com. So we strip
 * RFC 5322 comments and quoted-string display-names first (a `<>` inside them is not an
 * address), then take the LAST angle-addr (or the bare addr-spec) — the one the MUA shows.
 */

import { parseMessage } from './parse.ts';
import { stripComments } from './cfws.ts';

/**
 * The author addr-spec of a single From header VALUE, spoof-hardened as above. Returns
 * `local@domain` as written (surrounding WSP removed), or null if there is no `@`.
 */
export function authorAddrSpec(value: string): string | null {
  // Comments first (a nested comment must be O(n), not O(depth²) — a crafted one froze the
  // event loop, DMARC audit run-3), then quoted-string display-names.
  let v = stripComments(value);
  v = v.replace(/"(?:[^"\\]|\\.)*"/g, ' ').trim();
  const open = v.lastIndexOf('<');
  let addr: string;
  if (open !== -1) {
    const close = v.indexOf('>', open);
    addr = (close !== -1 ? v.slice(open + 1, close) : v.slice(open + 1)).trim();
  } else {
    addr = v.trim();
  }
  return addr.includes('@') ? addr : null;
}

/** The lower-cased domain of an addr-spec, with a root-anchoring trailing dot removed so it
 *  aligns with a dot-less DKIM `d=` / SPF domain. Null if there is no `@`. */
export function domainOfAddrSpec(addr: string): string | null {
  const at = addr.lastIndexOf('@');
  if (at === -1) return null;
  const domain = addr.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  return domain || null;
}

/**
 * The From author of a raw message: the single addr-spec (spoof-hardened) and how many From
 * headers the message carries. RFC 5322 §3.6.1 requires exactly one From; more than one is
 * the canonical display-spoof (auth aligns one, the MUA may show another), so both DMARC and
 * the send-as gate treat count>1 as never-authentic. Reads only the first From's value; the
 * count is what the callers use to reject the multi-From case.
 */
export function fromAuthor(raw: Buffer): { address: string | null; count: number } {
  const { headers } = parseMessage(raw);
  const froms = headers.filter((h) => h.name.toString('latin1').trim().toLowerCase() === 'from');
  if (froms.length === 0) return { address: null, count: 0 };
  return { address: authorAddrSpec(froms[0]!.value.toString('latin1')), count: froms.length };
}
