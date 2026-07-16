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

/** Canonicalise a mailbox name: any-case INBOX becomes "INBOX"; other names are unchanged. */
export function canonicalMailboxName(name: string, defects: MailboxNameDefects = {}): string {
  if (defects.caseSensitiveInbox !== true && name.toUpperCase() === 'INBOX') return 'INBOX';
  return name;
}

/** Do two names refer to the same mailbox (INBOX case-insensitive, others exact)? */
export function sameMailbox(a: string, b: string, defects: MailboxNameDefects = {}): boolean {
  return canonicalMailboxName(a, defects) === canonicalMailboxName(b, defects);
}
