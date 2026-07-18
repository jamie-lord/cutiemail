/**
 * Strip RFC 5322 CFWS comments — parenthesised, nestable, with quoted-pairs — from a
 * header value in a single linear pass. Each balanced top-level comment collapses to one
 * space (a comment is folding whitespace, §3.2.2); a `\`-escaped octet inside a comment
 * is consumed with its escape; an unbalanced trailing `(` (malformed) is treated as a
 * comment running to the end and dropped (fail-closed: the caller then extracts no address
 * / no authserv-id rather than trusting attacker text past a stray paren).
 *
 * This replaces an earlier fixed-point `do { v = v.replace(/\([^()]*\)/g, ' ') } while
 * (v !== prev)` idiom used in both dmarc-inbound (From) and received (Authentication-
 * Results). That peeled exactly one nesting layer per pass, so a balanced comment nested
 * D deep forced D O(n) passes — O(D²). A single unauthenticated message carrying a deeply
 * nested comment in From or Authentication-Results (a header may be up to the whole 25 MiB
 * message-size cap) froze the entire single-threaded event loop before any DNS or crypto
 * work ran (audit run-3, HIGH — itself a regression introduced by run-2's From-parser fix).
 * This scan is O(n) in the value length regardless of nesting depth.
 */
export function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && depth > 0) {
      i++; // quoted-pair inside a comment: drop the backslash and the escaped octet
      continue;
    }
    if (ch === '(') {
      if (depth === 0) out += ' ';
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      else out += ch; // a stray unmatched ')' outside any comment is literal
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}
