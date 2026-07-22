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
  // Comments first (a nested comment must be O(n), not O(depth²) — a crafted one can freeze
  // the event loop), then quoted-string display-names.
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
 * How many author mailboxes a single From header VALUE carries. RFC 5322 §3.6.1: From is a
 * mailbox-list (comma-separated mailboxes), each mailbox holding exactly one addr-spec. A
 * value with more than one mailbox is a DMARC hazard (RFC 7489 §6.6.1): auth may align one
 * mailbox while the MUA renders another, so `From: victim@bank.com, x@evil.com` with an aligned
 * DKIM d=evil.com would otherwise forge a pass. Strip comments and quoted-string display-names
 * first (a `,` inside them is not a mailbox separator, so `"Alice, Example" <a@x>` stays one),
 * then count the comma-separated segments that carry an addr-spec (`@`). The strip order is the
 * SAME as authorAddrSpec, so the count and the extracted address can never disagree.
 */
export function mailboxCount(value: string): number {
  let v = stripComments(value);
  v = v.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  return v.split(',').filter((seg) => seg.includes('@')).length;
}

/**
 * The From author of a raw message: the single addr-spec (spoof-hardened) and how many author
 * mailboxes the message carries. RFC 5322 §3.6.1 requires exactly one From with exactly one
 * mailbox; more than one From header OR more than one mailbox in the single From value is the
 * canonical display-spoof (auth aligns one, the MUA may show another), so both DMARC and the
 * send-as gate treat count>1 as never-authentic. Reads the first From's value for the address;
 * the count spans both the multi-header case (froms.length) and the multi-mailbox-single-header
 * case (mailboxCount) so neither variant can slip past reported as count 1.
 */
export function fromAuthor(raw: Buffer): { address: string | null; count: number } {
  const { headers } = parseMessage(raw);
  const froms = headers.filter((h) => h.name.toString('latin1').trim().toLowerCase() === 'from');
  if (froms.length === 0) return { address: null, count: 0 };
  const value = froms[0]!.value.toString('latin1');
  const count = froms.length > 1 ? froms.length : mailboxCount(value);
  return { address: authorAddrSpec(value), count };
}
