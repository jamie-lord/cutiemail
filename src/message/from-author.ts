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
 *
 * The shown address, the mailbox COUNT, and the full DMARC domain list all derive from one
 * tokenizer (`mailboxAddrSpecs`), so they can never disagree about where one mailbox ends and the
 * next begins — including the comma-less `<a@x> <b@y>` form, where every angle-addr is a mailbox a
 * recipient might render and whose domain DMARC (RFC 9989 §11.5) must weigh, not just the last.
 */

import { domainToASCII } from 'node:url';
import { parseMessage } from './parse.ts';
import { stripComments } from './cfws.ts';

/** Defects that make the author extractor under-report, for the corpus negative controls. */
export interface AuthorDomainDefects {
  /**
   * Enumerate only the LAST angle-addr in each comma segment, dropping the earlier ones. This is
   * the exact defect behind the comma-less two-angle DMARC bypass: `mailboxCount` counts BOTH
   * angle-addrs (so the spoof path fires) while the domain list saw only the last, so a victim's
   * `p=reject` carried in `<victim@bank> <attacker@evil>` was never queried. Violates RFC 9989
   * §11.5 ("apply the DMARC mechanism to each domain found in the RFC5322.From field").
   */
  readonly lastAngleOnlyPerSegment?: boolean;
}

/**
 * Every author mailbox's addr-spec in a single From header VALUE, IN ORDER, spoof-hardened. This
 * is the ONE tokenizer the count, the shown address, and the domain list all derive from, so they
 * can never disagree about where one mailbox ends and the next begins — the disagreement between
 * `mailboxCount` (which counted angle-addrs) and the old comma-only domain walk was precisely the
 * bug this closes.
 *
 * Comments first (a nested comment must be O(n), not O(depth²) — a crafted one can freeze the
 * event loop), then quoted-string display-names, then §3.4 group syntax — all before any structural
 * character is read, so `<`, `,` and `;` mean what the grammar says they mean. A comma segment can
 * still hold MORE THAN ONE mailbox when they are written as bare angle-addrs with no separator
 * (`<a@x> <b@y>`): RFC 5322 §3.6.1 permits only one, so this is never authentic, but each is a
 * mailbox a recipient MUA might render and whose domain DMARC (RFC 9989 §11.5) MUST weigh — so emit
 * every angle-addr, not just the last.
 */
function mailboxAddrSpecs(value: string, defects: AuthorDomainDefects = {}): string[] {
  const v = unwrapGroup(stripDisplayNames(value));
  const specs: string[] = [];
  for (const segment of v.split(',')) {
    const angles = segment.match(/<[^<>]*>/g);
    if (angles !== null) {
      const chosen = defects.lastAngleOnlyPerSegment === true ? [angles[angles.length - 1]!] : angles;
      for (const a of chosen) {
        const inner = a.slice(1, -1).trim();
        if (inner.includes('@')) specs.push(inner);
      }
    } else if (segment.includes('<')) {
      // An unclosed angle: take what follows the last `<`, the legacy single-mailbox reading.
      const inner = segment.slice(segment.lastIndexOf('<') + 1).trim();
      if (inner.includes('@')) specs.push(inner);
    } else {
      const bare = segment.trim();
      if (bare.includes('@')) specs.push(bare);
    }
  }
  return specs;
}

/**
 * The author addr-spec of a single From header VALUE, spoof-hardened as above. Returns
 * `local@domain` as written (surrounding WSP removed), or null if there is no `@`.
 */
export function authorAddrSpec(value: string): string | null {
  // The LAST mailbox, for the display-spoof reason in the module header (a decoy hides earlier;
  // the client renders the last). Where more than one exists the caller is told so via `count`,
  // and DMARC evaluates every domain rather than trusting this one.
  const specs = mailboxAddrSpecs(value);
  return specs.length > 0 ? specs[specs.length - 1]! : null;
}

/**
 * A syntactically valid DNS name: labels of letters/digits/hyphen, not starting or ending with
 * a hyphen, separated by single dots. Deliberately the same shape the SPF identity is held to
 * in main.ts, and for the same reason stated there.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The lower-cased domain of an addr-spec, or null if it is not one a receiver could ever
 * query.
 *
 * Two things happen here beyond lower-casing. Interior whitespace is folded out, because
 * RFC 5322 §4.4's `obs-domain = atom *("." atom)` permits CFWS around each atom — so
 * `victim@bank .com` is the domain `bank.com` to a compliant parser, and reading it as
 * `bank .com` is a divergence from what the recipient is shown. ALL trailing dots are stripped
 * (not one), matching `registeredDomain` and `organizationalDomain`, which strip `/\.+$/`;
 * stripping only one left `bank.com.` behind and sent the policy walk above the public-suffix
 * floor its own documentation says it never crosses.
 *
 * And the result is SHAPE-CHECKED. Without that, a From of `victim@bank.com,` yielded the
 * "domain" `bank.com,`; c-ares rejects that name with EBADNAME, the resolver rethrows it,
 * `checkDmarc` maps the throw to temperror, and enforcement only acts on `fail` — so the most
 * malformed input received the most lenient handling and a p=reject spoof reached the INBOX.
 * A value that cannot be a DNS name must not be turned into one.
 */
export function domainOfAddrSpec(addr: string): string | null {
  const at = addr.lastIndexOf('@');
  if (at === -1) return null;
  const domain = addr
    .slice(at + 1)
    .replace(/[ \t]+/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (domain === '') return null;
  // Check the A-label form, not the literal one: an IDN From is commonly written as U-labels
  // (RFC 6376 §3.5), and those are not ASCII hostnames until they are encoded. Checking the
  // raw string would reject every internationalised sender. `domainToASCII` returns '' for
  // input it cannot encode, and leaves the delimiters this guard exists to catch — `,` `;` —
  // untouched, so both classes are still refused. The U-label form is what we RETURN, because
  // that is what the caller compares and re-encodes.
  const ascii = domainToASCII(domain);
  return HOSTNAME.test(ascii === '' ? domain : ascii) ? domain : null;
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
  // The count is exactly the number of mailboxes `mailboxAddrSpecs` extracts, so it can NEVER
  // disagree with the domain list `authorDomains` builds from the same tokenizer — including the
  // comma-less `<bob@x> <alice@x>` case, two mailboxes with no separator.
  return mailboxAddrSpecs(value).length;
}

/**
 * Strip the lexical contexts in which a `,`, `<`, `:` or `;` is NOT structural: RFC 5322
 * comments first (quote-aware, see cfws.ts), then quoted-string display-names. Every function
 * here does this in the same order, so the count, the address and the domain list can never
 * disagree about where one mailbox ends and the next begins.
 */
function stripDisplayNames(value: string): string {
  return stripComments(value).replace(/"(?:[^"\\]|\\.)*"/g, ' ');
}

/**
 * Unwrap RFC 5322 §3.4 group syntax, which RFC 6854 §2.1 explicitly permits in From:
 * `group = display-name ":" [group-list] ";" [CFWS]`. The mailboxes are the group members.
 *
 * Without this, `From: Accounts: victim@bank.com;` was read as the single addr-spec
 * `Accounts: victim@bank.com;`, whose "domain" was `bank.com;` — unqueryable, so no policy was
 * ever discovered, while every compliant parser shows the reader `victim@bank.com`. Call only
 * after display-names are stripped, so a `:` inside one cannot be mistaken for the delimiter
 * (an addr-spec cannot contain a bare `:`).
 */
function unwrapGroup(stripped: string): string {
  const m = /^[^:@<>]*:([\s\S]*);[ \t]*$/.exec(stripped.trim());
  return m === null ? stripped : m[1]!;
}

/**
 * Every author mailbox's domain, in the order written, de-duplicated, and each shape-checked.
 *
 * DMARC needs the whole list, not one representative. RFC 5322 §3.6.1 permits exactly one
 * mailbox in From, so more than one is never authentic — but "never authentic" is only useful
 * if the policy that gets ENFORCED is one the attacker cannot choose. Selecting a single
 * mailbox let them append their own policy-less address and pick which zone governed the
 * message, which RFC 9989 §11.5 describes precisely and answers with "apply the DMARC mechanism
 * to each domain found in the RFC5322.From field … and apply the most strict policy selected
 * among the checks that fail".
 */
export function authorDomains(value: string, defects: AuthorDomainDefects = {}): string[] {
  const out: string[] = [];
  // Every mailbox's domain, from the SAME tokenizer `mailboxCount` uses — so the set of domains
  // DMARC evaluates matches the set of mailboxes the count guard detected. Splitting on commas
  // alone and keeping only the last angle-addr per segment (the `lastAngleOnlyPerSegment` defect)
  // dropped a victim domain carried alongside a policy-less one in `<victim@bank> <attacker@evil>`.
  for (const addr of mailboxAddrSpecs(value, defects)) {
    const domain = domainOfAddrSpec(addr);
    if (domain !== null && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/**
 * Every author domain the WHOLE message asserts: across all From headers AND every mailbox in
 * each, de-duplicated in the order written. This is the multi-header companion to
 * `authorDomains` (which sees a single header value), and the whole-message analogue of
 * `fromAuthor`'s `count` — which already spans both `froms.length` and `mailboxCount`.
 *
 * DMARC (RFC 9989 §11.5) must "apply the DMARC mechanism to each domain found in the
 * RFC5322.From field … and apply the most strict policy selected among the checks that fail".
 * Reading only the first header's value let an attacker carry the victim's p=reject domain in a
 * SECOND From header, whose zone was then never queried, and file the spoof to the INBOX. The
 * single-header multi-mailbox variant of this was closed first; this is its structural twin, so
 * both the count and the domain enumeration now derive the From-header set through
 * `isFromHeader` — they cannot disagree about which headers are in play.
 */
export function allAuthorDomains(raw: Buffer): string[] {
  const { headers } = parseMessage(raw);
  const out: string[] = [];
  for (const h of headers) {
    if (!isFromHeader(h.name)) continue;
    for (const domain of authorDomains(h.value.toString('latin1'))) {
      if (!out.includes(domain)) out.push(domain);
    }
  }
  return out;
}

/**
 * Whether a parsed header is a From header (RFC 5322 §3.6.1). Every place that enumerates or
 * counts From headers normalises the field name the SAME way here, so `fromAuthor`'s `count`
 * (from `froms.length`) and `allAuthorDomains`'s enumeration can never disagree about which
 * headers are the From set — a disagreement would let `count>1` force a spoof verdict while the
 * domain walk saw only one domain.
 */
function isFromHeader(name: Buffer): boolean {
  return name.toString('latin1').trim().toLowerCase() === 'from';
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
export function fromAuthor(raw: Buffer): { address: string | null; count: number; value: string | null } {
  const { headers } = parseMessage(raw);
  const froms = headers.filter((h) => isFromHeader(h.name));
  if (froms.length === 0) return { address: null, count: 0, value: null };
  const value = froms[0]!.value.toString('latin1');
  const count = froms.length > 1 ? froms.length : mailboxCount(value);
  // `value` is returned so a caller can tell "no From header" from "a From header we could not
  // resolve to an address" — the two must not be handled the same way, since the second is a
  // malformed author and the first is simply an absence.
  return { address: authorAddrSpec(value), count, value };
}
