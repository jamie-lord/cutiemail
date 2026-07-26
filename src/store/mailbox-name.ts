/**
 * IMAP mailbox-name resolution (RFC 9051 §5.1), with a defect.
 *
 * "INBOX" is case-insensitive (any casing means the primary mailbox); every other
 * mailbox name is case-sensitive. This pure resolver canonicalises names so lookups
 * agree, and is used wherever a mailbox name is matched (SELECT, LIST, STATUS, ...).
 */

export interface MailboxNameDefects {
  /** Treat INBOX case-sensitively. Violates R-9051-5.1-a. */
  readonly caseSensitiveInbox?: boolean;
}

/**
 * Canonicalise a mailbox name: a trailing hierarchy separator is stripped, then any-case
 * INBOX becomes "INBOX"; other names are otherwise unchanged.
 *
 * A trailing separator on CREATE is only a "this name will have children" declaration, and
 * a server that doesn't require it MUST ignore it (RFC 9051 §6.3.4) — so `Sent/` names the
 * same mailbox as `Sent`. Stripping it here (the single point every command resolves names
 * through) keeps CREATE/SELECT/DELETE/LIST in agreement. The separator is "/" throughout.
 */
export function canonicalMailboxName(name: string, defects: MailboxNameDefects = {}): string {
  let n = name;
  while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  // ASCII-only fold. RFC 9051 §9 defines the rule on the literal sequence "I" "N" "B" "O" "X",
  // whereas toUpperCase() is Unicode-aware and folds U+0131 (dotless i) into it — so 'ınbox'
  // would have named INBOX. Not reachable over the wire (the parser reads latin1, so a UTF-8
  // U+0131 arrives as two octets), but the exported resolver is used directly by the stores.
  if (defects.caseSensitiveInbox !== true && /^inbox$/i.test(n)) return 'INBOX';
  return n;
}

/** Do two names refer to the same mailbox (INBOX case-insensitive, others exact)? */
export function sameMailbox(a: string, b: string, defects: MailboxNameDefects = {}): boolean {
  return canonicalMailboxName(a, defects) === canonicalMailboxName(b, defects);
}

/**
 * The (old name -> new name) pairs a RENAME must apply: the named mailbox, plus every inferior
 * hierarchical name beneath it (RFC 9051 §6.3.6 — "a rename of 'foo' to 'zap' will rename
 * 'foo/bar' ... to 'zap/bar'").
 *
 * A subtree operation, not a single-row update, and the difference is data loss. A server that
 * renames only the named mailbox leaves every child stranded under a parent that no longer exists:
 * unreachable under the old name because the hierarchy above it moved, and unreachable under the
 * new one because it never moved. The mail is still on disk and no client can see it.
 *
 * The separator is "/" throughout (see the NAMESPACE response). Matching on `${from}/` rather than
 * a bare prefix is what keeps "foobar" out of "foo"'s subtree — a plain startsWith would rename an
 * unrelated sibling whose name merely begins with the same letters.
 *
 * Shared by MemoryCatalog and SqliteCatalog so the reference and the real store cannot drift; the
 * differential oracle compares them, and a rule duplicated in both is a rule the oracle cannot see
 * is wrong.
 */
export function subtreeRenames(from: string, to: string, names: readonly string[]): ReadonlyArray<readonly [string, string]> {
  const prefix = `${from}/`;
  return names
    .filter((n) => n === from || n.startsWith(prefix))
    .map((n) => [n, `${to}${n.slice(from.length)}`] as const);
}
