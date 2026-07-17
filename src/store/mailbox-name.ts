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
  if (defects.caseSensitiveInbox !== true && n.toUpperCase() === 'INBOX') return 'INBOX';
  return n;
}

/** Do two names refer to the same mailbox (INBOX case-insensitive, others exact)? */
export function sameMailbox(a: string, b: string, defects: MailboxNameDefects = {}): boolean {
  return canonicalMailboxName(a, defects) === canonicalMailboxName(b, defects);
}
