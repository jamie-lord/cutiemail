/**
 * Strip RFC 5322 CFWS comments from a header value in a single linear pass that is
 * QUOTE-AWARE: comments and quoted-strings are mutually-exclusive lexical contexts
 * (§3.2.2 / §3.2.4), so a `(` inside a quoted-string is literal `qtext`, NOT a comment
 * start, and a `"` inside a comment is `ctext`, not a quote delimiter. Comments are
 * removed (each top-level comment → one space; nested comments collapse); quoted-strings
 * are PRESERVED verbatim (the caller decides what to do with them — `authorAddrSpec`
 * (message/from-author.ts) strips them next to find the address; `authservIdOf` interprets a
 * quoted authserv-id).
 * Quoted-pairs (`\x`) are consumed with their escape in both contexts. An unbalanced
 * trailing `(` (malformed) is treated as a comment to end-of-value and dropped
 * (fail-closed).
 *
 * Why a single quote-aware pass, and not something simpler — two naive approaches are unsafe:
 *  - Iterating `do { v = v.replace(/\([^()]*\)/g, ' ') } while (v !== prev)`
 *    is O(depth^2): a deeply nested comment in From/Authentication-Results freezes the
 *    single-threaded event loop on one unauthenticated message (a DoS).
 *  - A linear strip that is NOT quote-aware and runs BEFORE the caller's
 *    separate quoted-string strip mis-reads a `(` planted inside a From display-name
 *    quoted-string as a comment — which unbalances the closing `"` and
 *    re-exposes an attacker angle-addr, reopening the DMARC From-domain differential
 *    (`From: "<a@attacker.com>(" <victim@bank.com>` aligns DMARC on attacker.com while
 *    every MUA displays victim@bank.com). Two sequential phases cannot match
 *    RFC 5322 lexing; this single interleaved pass can.
 *
 * O(n) in the value length regardless of nesting depth.
 */
export function stripComments(value: string): string {
  let out = '';
  let depth = 0; // comment nesting depth (always 0 while inside a quoted-string)
  let inQuote = false; // inside a quoted-string (only enterable at depth 0)
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inQuote) {
      // Preserve the quoted-string verbatim (delimiters included); a quoted-pair escapes
      // the next octet; a bare `"` closes it. Comments do not apply here.
      out += ch;
      if (ch === '\\' && i + 1 < value.length) {
        out += value[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (depth > 0) {
      // Inside a comment: drop the content.
      if (ch === '\\') {
        i++; // quoted-pair inside a comment: drop the backslash and the escaped octet
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    // Outside comments and quoted-strings:
    if (ch === '"') {
      inQuote = true; // a quoted-string starts — kept, not treated as a comment context
      out += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      out += ' '; // a comment starts → collapses to one space
      continue;
    }
    out += ch; // an ordinary char (a stray unmatched ')' outside any comment is literal)
  }
  return out;
}
