/**
 * RFC 9051 (IMAP4rev2) — Client Commands (the command-line surface)
 *
 * The other half of the IMAP wire: what the client sends. A command is a tag, a
 * command name, and arguments, with strict spacing — IMAP is unusually strict here
 * ("missing or extraneous spaces" is a syntax error), and a server must accept a
 * reused tag rather than assuming client-side uniqueness. This section captures the
 * command-line structure a server MUST parse; command semantics (SELECT, FETCH,
 * SEARCH, ...) and literals are later increments.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_COMMANDS = [
  {
    id: 'R-9051-2.2.1-a',
    rfc: 'rfc9051',
    section: '2.2.1',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'It is a syntax error to send a command with missing or extraneous spaces or arguments.',
    testability: { kind: 'parse' },
    note:
      'IMAP spacing is strict: a leading/trailing space or a doubled space between ' +
      'tokens is a syntax error, not something to be lenient about. Our command ' +
      'parser flags sloppy spacing and a missing tag/command; the acceptSloppySpacing ' +
      'defect is the negative control. (Strictness here is a security property — ' +
      'lenient tokenising is where command-injection ambiguity creeps in.)',
  },
  {
    id: 'R-9051-2.2.1-b',
    rfc: 'rfc9051',
    section: '2.2.1',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'the client SHOULD generate a unique tag for every command, but a server MUST accept tag reuse.',
    testability: { kind: 'parse' },
    note:
      'The server side is the MUST: a reused tag must NOT be rejected. A server that ' +
      'assumes tags are unique (and errors on reuse) breaks conformant clients. Our ' +
      'parser accepts a repeated tag; the rejectTagReuse defect (fail the second use) ' +
      'is the negative control.',
  },
] as const satisfies readonly RequirementDef[];
