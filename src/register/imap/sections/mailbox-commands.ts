/**
 * RFC 9051 (IMAP4rev2) §6.3.2, §6.3.4 to §6.3.6, §6.3.11, §6.3.12 — the mailbox-management
 * commands: SELECT, CREATE, DELETE, RENAME, STATUS, APPEND.
 *
 * Every requirement here is `wire`: it binds the ASSEMBLED SERVER, and the only way to observe it
 * is to open a connection, authenticate, and drive the command. That distinction is the reason this
 * file exists. The IMAP register until now was entirely `parse` — requirements anchored to the
 * parser and the reference mailbox model — and a parser can be perfectly correct while the server
 * built on top of it answers the wrong thing. That is precisely how a MUST-level SMTP gap
 * (`RCPT TO:<postmaster>`, ADR 0026) survived for so long: every function involved was right, and
 * the defect lived in the wiring between them.
 *
 * SCOPE (ADR 0007). IMAP4rev2 only, with a curated extension set. Requirements that exist purely to
 * serve the IMAP4rev1 long tail, or features this server deliberately does not implement, are
 * recorded with `deliberatelyUncovered` rather than omitted — a shrinking denominator flatters
 * coverage, which is the opposite of what this register is for.
 *
 * Verbatim quotes from spec/rfc9051.txt. RFC 9051 is a modern RFC with no page furniture in its
 * text, so `page` follows the published pagination, on the same scale as the entries already here.
 */

import type { RequirementDef } from '../../types.ts';

/** The state a case needs before it can observe anything. */
const AUTHED = 'an authenticated session';
const AUTHED_MAILBOX = 'an authenticated session and a mailbox that can be created and deleted';

export const IMAP_MAILBOX_COMMANDS = [
  {
    id: 'R-9051-6.3.2-a',
    rfc: 'rfc9051',
    section: '6.3.2',
    page: 44,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Before returning an OK to the client, the server MUST send the following untagged data to the client.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The untagged data SELECT owes is enumerated immediately after this sentence: FLAGS, EXISTS '
      + 'and LIST untagged responses, plus OK responses carrying PERMANENTFLAGS, UIDNEXT and '
      + 'UIDVALIDITY. A client that does not receive them cannot establish a baseline for the '
      + 'mailbox, so a missing one is not cosmetic — it breaks resynchronisation. The wire case '
      + 'SELECTs a mailbox and asserts each required item appears BEFORE the tagged OK, since '
      + '"before returning an OK" is the ordering half of the requirement.',
  },
  {
    id: 'R-9051-6.3.2-b',
    rfc: 'rfc9051',
    section: '6.3.2',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The list of mailbox attributes MUST be accurate.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The LIST response SELECT returns carries the mailbox attributes, and this forbids the easy '
      + 'shortcut of emitting a fixed attribute list. Observable: a mailbox with children must '
      + 'report \\HasChildren, one without must not, and a special-use mailbox must carry its '
      + 'attribute (RFC 6154, folded into rev2).',
  },
  {
    id: 'R-9051-6.3.2-c',
    rfc: 'rfc9051',
    section: '6.3.2',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'When deselecting a selected mailbox, the server MUST return an untagged OK response with the "[CLOSED]" response code when the currently selected mailbox is closed',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'New in rev2, and easy to miss when porting from rev1 where it did not exist. SELECTing a '
      + 'second mailbox while one is already selected implicitly closes the first, and the client '
      + 'needs [CLOSED] to know its cached state for the old mailbox is now stale. A server that '
      + 'silently switches leaves the client applying updates to the wrong mailbox.',
  },
  {
    id: 'R-9051-6.3.2-d',
    rfc: 'rfc9051',
    section: '6.3.2',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the client is not permitted to modify the mailbox but is permitted read access, the mailbox is selected as read-only, and the server MUST prefix the text of the tagged OK response to SELECT with the "[READ-ONLY]" response code.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'This server has no per-mailbox permission model, so SELECT is always read-write and the '
      + 'condition ("not permitted to modify") never holds. The requirement is registered rather '
      + 'than dropped because the SIBLING obligation — EXAMINE, which selects read-only by '
      + 'definition — is squarely in scope and is R-9051-6.3.3-b. Testing that SELECT reports '
      + '[READ-WRITE] and EXAMINE reports [READ-ONLY] covers the distinction this requirement '
      + 'exists to protect.',
    deliberatelyUncovered: {
      reason:
        'The server implements no per-mailbox access control, so a mailbox that is readable but '
        + 'not modifiable cannot be constructed. The observable half of the same distinction is '
        + 'covered by EXAMINE (R-9051-6.3.3-b).',
      date: '2026-07-26',
    },
  },
  {
    id: 'R-9051-6.3.3-b',
    rfc: 'rfc9051',
    section: '6.3.3',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The text of the tagged OK response to the EXAMINE command MUST begin with the "[READ-ONLY]" response code.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The observable half of the read-only contract, and the one a client acts on: a mail client '
      + 'that sees [READ-ONLY] disables flag changes in its UI. "Begin with" is part of the '
      + 'requirement — the response code is a prefix of the response text, not merely present '
      + 'somewhere in it.',
  },
  {
    id: 'R-9051-6.3.4-a',
    rfc: 'rfc9051',
    section: '6.3.4',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If a new mailbox is created with the same name as a mailbox that was deleted, its unique identifiers MUST be greater than any unique identifiers used in the previous incarnation of the mailbox unless the new incarnation has a different unique identifier validity value.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The rule that stops a client showing an old cached message under a new one\'s identity. Two '
      + 'legal ways to satisfy it: keep climbing the UID space, or move UIDVALIDITY. Either is '
      + 'conformant, so a wire case must accept both — assert that a message appended to the '
      + 'recreated mailbox either has a UID above the old high-water mark, or that UIDVALIDITY '
      + 'changed. Asserting only one would report a conformant server as broken.',
  },
  {
    id: 'R-9051-6.3.5-a',
    rfc: 'rfc9051',
    section: '6.3.5',
    page: 48,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The DELETE command MUST NOT remove inferior hierarchical names.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'Deleting "foo" must leave "foo/bar" intact. In scope: this server implements a hierarchy '
      + 'with "/" as the separator (mailbox-name.ts). The failure mode is data loss, and it is '
      + 'silent — a client that had "foo/bar" cached simply stops seeing it.',
  },
  {
    id: 'R-9051-6.3.5-b',
    rfc: 'rfc9051',
    section: '6.3.5',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The value of the highest-used unique identifier of the deleted mailbox MUST be preserved so that a new mailbox created with the same name will not reuse the identifiers of the former incarnation, unless the new incarnation has a different unique identifier validity value.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The DELETE-side statement of the same invariant as R-9051-6.3.4-a, and the reason a '
      + 'delete-then-create cycle cannot be implemented as "drop the row and start again". Same '
      + 'two-legal-answers shape: preserved UIDs, or a changed UIDVALIDITY.',
  },
  {
    id: 'R-9051-6.3.6-a',
    rfc: 'rfc9051',
    section: '6.3.6',
    page: 49,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the name has inferior hierarchical names, then the inferior hierarchical names MUST also be renamed.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'RENAME is a subtree operation, not a single-row update. Renaming "foo" to "baz" must move '
      + '"foo/bar" to "baz/bar". A server that renames only the named mailbox orphans every child, '
      + 'which reads to the client as mail disappearing.',
  },
  {
    id: 'R-9051-6.3.6-b',
    rfc: 'rfc9051',
    section: '6.3.6',
    page: 49,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The value of the highest-used unique identifier of the old mailbox name MUST be preserved so that a new mailbox created with the same name will not reuse the identifiers of the former incarnation, unless the new incarnation has a different unique identifier validity value.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The RENAME-side statement of the UID-reuse invariant. Renaming "foo" away frees the name, '
      + 'and a mailbox later created at "foo" must not hand out UIDs the old one already used. '
      + 'ADR 0016 records this server\'s related choice for the INBOX special case.',
  },
  {
    id: 'R-9051-6.3.11-a',
    rfc: 'rfc9051',
    section: '6.3.11',
    page: 59,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'However, servers MUST be able to execute the STATUS command on the selected mailbox.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'The sentence before this one tells CLIENTS they SHOULD NOT do it; this one tells servers '
      + 'they must cope when clients do it anyway — which real clients do. A server that answers '
      + 'NO or BAD for STATUS on the selected mailbox is non-conformant however sensible the '
      + 'reasoning. An unmirrored sibling guard in the making: the check that rejects it would look '
      + 'like a correctness improvement.',
  },
  {
    id: 'R-9051-6.3.12-a',
    rfc: 'rfc9051',
    section: '6.3.12',
    page: 60,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: "If the append is unsuccessful for any reason, the mailbox MUST be restored to its state before the APPEND attempt (other than possibly keeping the changed mailbox's UIDNEXT value); no partial appending is permitted.",
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_MAILBOX },
    note:
      'Atomicity, stated as a MUST. "No partial appending" is the operative half: a rejected APPEND '
      + 'must leave no half-written message behind. The parenthetical explicitly permits UIDNEXT to '
      + 'have advanced, which is what makes the UID-reuse rules above consistent with a failed '
      + 'append. Observable by attempting an APPEND that will be refused (over the size limit) and '
      + 'checking the message count and the mailbox contents are unchanged.',
  },
  {
    id: 'R-9051-6.3.12-b',
    rfc: 'rfc9051',
    section: '6.3.12',
    page: 60,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the destination mailbox does not exist, a server MUST return an error and MUST NOT automatically create the mailbox.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      'Two obligations in one sentence, and the second is the interesting one: the helpful '
      + 'behaviour — create it and carry on — is forbidden. A client relies on the error to '
      + 'discover that its cached mailbox list is stale; auto-creating hides that and quietly '
      + 'accumulates mailboxes from typos.',
  },
  {
    id: 'R-9051-6.3.12-c',
    rfc: 'rfc9051',
    section: '6.3.12',
    page: 60,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Unless it is certain that the destination mailbox cannot be created, the server MUST send the response code "[TRYCREATE]" as the prefix of the text of the tagged NO response.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      'The other half of R-9051-6.3.12-b: refusing is required, but the refusal has to tell the '
      + 'client that creating the mailbox and retrying would work. Without [TRYCREATE] a client '
      + 'saving to Sent for the first time gets an opaque NO and gives up. "As the prefix" is part '
      + 'of the requirement, as with [READ-ONLY].',
  },
] as const satisfies readonly RequirementDef[];
