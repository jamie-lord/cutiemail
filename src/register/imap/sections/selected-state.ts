/**
 * RFC 9051 (IMAP4rev2) §6.4.5 to §6.4.9 — the selected-state commands: FETCH, STORE, COPY, MOVE,
 * and the UID variants.
 *
 * These are where mail actually moves, so they carry the register's sharpest requirements: MOVE in
 * particular is specified as a safety property rather than a behaviour — "no message can be lost or
 * orphaned" — which is exactly the kind of statement a unit test on a store method cannot check and
 * a wire case can.
 *
 * All `wire`: they bind the assembled server, and the interesting failures live in the coordination
 * between the parser, the store and the response writer rather than in any one of them.
 *
 * SCOPE (ADR 0007). MOVE is in the curated extension set and is folded into rev2 anyway. UIDPLUS
 * response codes (COPYUID/APPENDUID, RFC 4315) are likewise part of rev2. Nothing here depends on
 * the rev1 long tail.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

const SELECTED = 'an authenticated session with a mailbox selected and at least one message in it';
const TWO_MAILBOXES = 'an authenticated session, a selected mailbox with messages, and a second mailbox to move or copy into';

export const IMAP_SELECTED_STATE = [
  {
    id: 'R-9051-6.4.5-a',
    rfc: 'rfc9051',
    section: '6.4.5',
    page: 67,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Most data items, identified in the formal syntax (Section 9) under the msg-att-static rule, are static and MUST NOT change for any particular message.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      'The guarantee a client caches against. ENVELOPE, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE '
      + 'and BODY[] are static for the life of a message, so a client is entitled to fetch them '
      + 'once and never again. Observable by fetching the static items twice, with a flag change '
      + 'in between, and requiring byte-identical answers — the flag change is there to catch an '
      + 'implementation that rebuilds a response from mutable state.',
  },
  {
    id: 'R-9051-6.4.5-b',
    rfc: 'rfc9051',
    section: '6.4.5',
    page: 67,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The \\Seen flag is implicitly set; if this causes the flags to change, they SHOULD be included as part of the FETCH responses.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      'Fetching BODY[] (not BODY.PEEK[]) marks the message read as a side effect. Reporting the '
      + 'resulting FLAGS in the same response is what stops two clients on one account disagreeing '
      + 'about what has been read: without it, the second client learns only on its next poll. A '
      + 'SHOULD, so declining is latitude rather than a finding — but this server does report it, '
      + 'and a case pins that it keeps doing so.',
  },
  {
    id: 'R-9051-6.4.5-c',
    rfc: 'rfc9051',
    section: '6.4.5',
    page: 67,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'A part of type MESSAGE/RFC822 or MESSAGE/GLOBAL also has nested part numbers, referring to parts of the MESSAGE part\'s body.',
    testability: { kind: 'parse' },
    note:
      'BODY[n] section numbering for an encapsulated message. A MESSAGE/RFC822 part is NOT a '
      + 'numbering level of its own: its encapsulated message’s parts are numbered directly at '
      + 'the message part’s level, so BODY[n.1] is the first part of the encapsulated message '
      + '(the numeric part specifier "refers to a part of type MESSAGE/RFC822"). resolvePart unwraps '
      + 'the message/rfc822 wrapper before applying the next index, matching the nested structure '
      + 'buildBodyStructure advertises — without it, BODY[n.1] returned the whole encapsulated '
      + 'message and BODY[n.2] an empty literal, the bytes disagreeing with BODYSTRUCTURE.',
  },
  {
    id: 'R-9051-6.4.6-a',
    rfc: 'rfc9051',
    section: '6.4.6',
    page: 68,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'A suffix of ".SILENT" in the data item name prevents the untagged FETCH, and the server SHOULD assume that the client has determined the updated value itself or does not care about the updated value.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      'The bandwidth optimisation clients lean on when marking a whole mailbox read. Two halves '
      + 'worth separating: .SILENT must suppress the untagged FETCH for the requesting connection, '
      + 'and the flag change must still HAPPEN. A server that treats .SILENT as "do nothing" would '
      + 'pass a naive check of the first half.',
  },
  {
    id: 'R-9051-6.4.7-a',
    rfc: 'rfc9051',
    section: '6.4.7',
    page: 69,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The flags and internal date of the message(s) SHOULD be preserved in the copy.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'A copy that loses INTERNALDATE re-sorts the destination mailbox by arrival time rather than '
      + 'the original, which is how "I filed this and now it is at the bottom" happens. Flags matter '
      + 'the same way: a copied message should not come back unread.',
  },
  {
    id: 'R-9051-6.4.7-b',
    rfc: 'rfc9051',
    section: '6.4.7',
    page: 69,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the destination mailbox does not exist, a server MUST return an error.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      'The COPY statement of the same rule APPEND carries (R-9051-6.3.12-b). Registered separately '
      + 'because it is a separate obligation on a separate command: an implementation can easily '
      + 'get one right and the other wrong, which is the recurring defect shape in this codebase — '
      + 'a guard applied to one path and not its sibling.',
  },
  {
    id: 'R-9051-6.4.7-c',
    rfc: 'rfc9051',
    section: '6.4.7',
    page: 69,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'It MUST NOT automatically create the mailbox.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      'The forbidden helpful behaviour, again. Quoted as its own sentence because the RFC states it '
      + 'as one; the error and the refusal to create are independently checkable, and a server '
      + 'could return an error while still having created the mailbox.',
  },
  {
    id: 'R-9051-6.4.7-d',
    rfc: 'rfc9051',
    section: '6.4.7',
    page: 69,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the COPY command is unsuccessful for any reason, server implementations MUST restore the destination mailbox to its state before the COPY attempt (other than possibly incrementing UIDNEXT), i.e., partial copy MUST NOT be done.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'Atomicity across a message SET, not a single message: copying five messages where the third '
      + 'fails must leave none of them. Observable by copying a set containing one valid and one '
      + 'nonexistent UID and asserting the destination is untouched.',
  },
  {
    id: 'R-9051-6.4.8-a',
    rfc: 'rfc9051',
    section: '6.4.8',
    page: 69,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'In particular, though the COPY and EXPUNGE response codes will be returned, response codes for a STORE MUST NOT be generated, and the \\Deleted flag MUST NOT be set for any message.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'MOVE is specified as COPY + STORE \\Deleted + EXPUNGE, and this forbids that being visible. '
      + 'A server implemented literally as those three commands would leak the \\Deleted flag onto '
      + 'messages, which another connection would then see. Observable from a SECOND connection '
      + 'watching the source mailbox during a MOVE.',
  },
  {
    id: 'R-9051-6.4.8-b',
    rfc: 'rfc9051',
    section: '6.4.8',
    page: 69,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Regardless of whether the command is successful in moving the entire set, each individual message MUST be either moved or unaffected.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'Per-message atomicity: a partial MOVE is permitted, a partially-moved MESSAGE is not. This '
      + 'is what makes MOVE safe to retry.',
  },
  {
    id: 'R-9051-6.4.8-c',
    rfc: 'rfc9051',
    section: '6.4.8',
    page: 69,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The server MUST leave each message in a state where it is in at least one of the source or target mailboxes (no message can be lost or orphaned).',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'The strongest requirement in this file, and the one worth designing tests around: the RFC '
      + 'states MOVE as a safety property rather than a sequence of steps. Duplicates are tolerable '
      + '(the next sentence downgrades that to SHOULD NOT); loss is not. Checkable over the wire by '
      + 'counting messages in both mailboxes before and after, including for a MOVE that fails.',
  },
  {
    id: 'R-9051-6.4.8-d',
    rfc: 'rfc9051',
    section: '6.4.8',
    page: 70,
    level: 'REQUIRED',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Servers are also REQUIRED to send the COPYUID response code in an untagged OK before sending EXPUNGE or similar responses.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_MAILBOXES },
    note:
      'Ordering is the requirement. COPYUID tells the client which UIDs the messages landed on in '
      + 'the destination; arriving after the EXPUNGE responses, the client has already been told '
      + 'the source messages are gone and has nothing left to correlate them with. A server that '
      + 'emits both but in the wrong order satisfies a presence check and fails this one.',
  },
  {
    id: 'R-9051-6.4.9-a',
    rfc: 'rfc9051',
    section: '6.4.9',
    page: 71,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'However, server implementations MUST implicitly include the UID message data item as part of any FETCH response caused by a UID command, regardless of whether a UID was specified as a message data item to the FETCH.',
    testability: { kind: 'wire-with-fixture', fixture: SELECTED },
    note:
      '`UID FETCH 1 (FLAGS)` must answer with UID as well as FLAGS, even though the client did not '
      + 'ask for it. Without it the client cannot tell which message the response is about: the '
      + 'untagged FETCH is keyed by sequence number, which is exactly what a UID command is trying '
      + 'to avoid depending on.',
  },
] as const satisfies readonly RequirementDef[];
