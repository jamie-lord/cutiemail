/**
 * RFC 9051 (IMAP4rev2) §6.3.9 and §6.3.9.5 — LIST, its options and the CHILDREN attributes — and
 * §6.3.13 — IDLE.
 *
 * LIST is how every mail client discovers what mailboxes exist, so a server that gets it subtly
 * wrong presents a client with folders that are not there, or hides folders that are. Two of the
 * requirements below are worth reading carefully because they pull in opposite directions: an
 * unrecognised OPTION is a BAD, while an unaccepted PATTERN must be silently ignored and still
 * return OK. Treating the second like the first breaks hierarchy browsing; treating the first like
 * the second lets a client believe an option took effect when it did not.
 *
 * IDLE is in the curated extension set (ADR 0007) and is folded into rev2 anyway. It is also the
 * mechanism behind push mail, which makes §6.3.13's UID requirement load-bearing rather than
 * decorative.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

const AUTHED = 'an authenticated session';
const AUTHED_HIERARCHY = 'an authenticated session and mailboxes forming a hierarchy';

export const IMAP_LIST_AND_IDLE = [
  {
    id: 'R-9051-6.3.9-a',
    rfc: 'rfc9051',
    section: '6.3.9',
    page: 50,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The returned mailbox names MUST match the supplied mailbox name pattern(s).',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_HIERARCHY },
    note:
      'The base guarantee, and the one a wildcard bug breaks in the most confusing way. "%" matches '
      + 'within one hierarchy level and "*" crosses levels, so `LIST "" %` must return the top level '
      + 'and NOT its children — a server that treats both as "*" shows a client a flat list of every '
      + 'mailbox where it expected a folder tree.',
  },
  {
    id: 'R-9051-6.3.9-b',
    rfc: 'rfc9051',
    section: '6.3.9',
    page: 51,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Any syntactically valid pattern that is not accepted by a server for any reason MUST be silently ignored, i.e., it results in no LIST responses, and the LIST command still returns a tagged OK response.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      'A pattern matching nothing is an empty answer, not an error: OK with no untagged LIST. This is '
      + 'the opposite of the rule for unrecognised OPTIONS (R-9051-6.3.9-d), and confusing the two is '
      + 'easy — a client walking a hierarchy asks about names that may not exist, and a server that '
      + 'answers NO stops the walk dead.',
  },
  {
    id: 'R-9051-6.3.9-c',
    rfc: 'rfc9051',
    section: '6.3.9',
    page: 51,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Return options MUST NOT cause the server to report information about additional mailbox names other than those that match the canonical LIST patterns and selection options.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_HIERARCHY },
    note:
      'A return option changes what is said ABOUT the matched mailboxes, never which mailboxes match. '
      + 'Adding RETURN (CHILDREN) to a pattern must not widen the result set — an easy mistake if the '
      + 'option is implemented by walking children and emitting them.',
  },
  {
    id: 'R-9051-6.3.9-d',
    rfc: 'rfc9051',
    section: '6.3.9',
    page: 51,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'A server MUST respond to options it does not recognize with a BAD response.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      'BAD, not silence and not OK. A client sends an option because it intends to rely on the '
      + 'answer; a server that ignores an option it does not implement returns a well-formed reply '
      + 'the client will misread. Contrast R-9051-6.3.9-b, where silence is exactly right.',
  },
  {
    id: 'R-9051-6.3.9-e',
    rfc: 'rfc9051',
    section: '6.3.9',
    page: 51,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The client SHOULD NOT specify any option more than once; however, if the client does this, the server MUST act as if it received the option only once.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_HIERARCHY },
    note:
      'Idempotence, stated for the server even though the client is told not to do it. Worth a case '
      + 'because "act as if once" has an observable failure mode: a duplicated return option emitting '
      + 'duplicated attributes, or the same mailbox listed twice.',
  },
  {
    id: 'R-9051-6.3.9.5-a',
    rfc: 'rfc9051',
    section: '6.3.9.5',
    page: 53,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The CHILDREN return option defines two new attributes that MUST be returned within a LIST response: \\HasChildren and \\HasNoChildren.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_HIERARCHY },
    note:
      'Both attributes, not just the interesting one. \\HasNoChildren is what lets a client draw a '
      + 'leaf without a disclosure triangle; omitting it leaves the client unable to distinguish '
      + '"no children" from "not told", and it will probe every mailbox to find out.',
  },
  {
    id: 'R-9051-6.3.9.5-b',
    rfc: 'rfc9051',
    section: '6.3.9.5',
    page: 53,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the CHILDREN return option is present, the server MUST return these attributes even if their computation is expensive.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED_HIERARCHY },
    note:
      'Explicitly forecloses the optimisation of omitting the attributes when they are costly. The '
      + 'client asked; cost is not an excuse. Registered separately from the attribute definition '
      + 'because it is a separate obligation and a plausible place to cut a corner under load.',
  },
  {
    id: 'R-9051-6.3.13-a',
    rfc: 'rfc9051',
    section: '6.3.13',
    page: 60,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the server chooses to send unsolicited FETCH responses, they MUST include a UID FETCH item.',
    testability: { kind: 'wire-with-fixture', fixture: 'two authenticated sessions, one idling on a mailbox the other changes' },
    note:
      'Push mail depends on this. An unsolicited FETCH arrives with no command to correlate it to, so '
      + 'the sequence number it is keyed by may already be stale in the client\'s view; the UID is the '
      + 'only stable handle. Same reasoning as the implicit UID on UID FETCH (R-9051-6.4.9-a), applied '
      + 'to data the client never asked for.',
  },
  {
    id: 'R-9051-6.3.13-b',
    rfc: 'rfc9051',
    section: '6.3.13',
    page: 61,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'At that point, the server MAY send any remaining queued untagged responses and then MUST immediately send the tagged response to the IDLE command and prepare to process other commands.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      '"Immediately" on receiving DONE. A client ends IDLE because it has something to do, and every '
      + 'millisecond the server spends before the tagged OK is a millisecond the user waits — this is '
      + 'the responsiveness half of push mail. Observable by timing DONE to the tagged completion.',
  },
] as const satisfies readonly RequirementDef[];
