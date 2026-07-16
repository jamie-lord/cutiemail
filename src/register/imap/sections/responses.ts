/**
 * RFC 9051 (IMAP4rev2) — Server Responses (the response-line surface)
 *
 * The read leg. An IMAP client acts on a server response by its FIRST token — a
 * tag, "*", or "+" — and a whole class of client bugs comes from mishandling that
 * dispatch or the status-response tagging rules. This first IMAP register section
 * captures the response-format invariants a conformant server MUST generate (and a
 * client MUST parse): the three response shapes, the five status conditions, the
 * always-untagged rule for PREAUTH/BYE, and the bracketed response code.
 *
 * Opinionated scope (ADR 0007): IMAP4rev2 only (RFC 9051), not the IMAP4rev1 long
 * tail. Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const IMAP_RESPONSES = [
  {
    id: 'R-9051-2.2.2-a',
    rfc: 'rfc9051',
    section: '2.2.2',
    page: 11,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'the first token of the response, which can be a tag, a "*", or a "+".',
    testability: { kind: 'parse' },
    note:
      'The response dispatch: a client "takes action on the response based upon the ' +
      'first token". Our parser classifies every response line as tagged (a tag), ' +
      'untagged ("*"), or continuation ("+"); the treatPlusAsData defect (fail to ' +
      'recognise the continuation) is the negative control. Prose, but a hard MUST ' +
      'in force — mis-dispatching a "+" deadlocks the session.',
  },
  {
    id: 'R-9051-7.1-a',
    rfc: 'rfc9051',
    section: '7.1',
    page: 95,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'Status responses are OK, NO, BAD, PREAUTH, and BYE.',
    testability: { kind: 'parse' },
    note:
      'The five status-response conditions. Our parser recognises each as a ' +
      'condition (distinct from untagged server data like "* 5 EXISTS"); the ' +
      'dontRecognizeBye defect (miss BYE) is the negative control — and missing BYE ' +
      'means missing the server signalling connection shutdown.',
  },
  {
    id: 'R-9051-7.1-b',
    rfc: 'rfc9051',
    section: '7.1',
    page: 95,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'OK, NO, and BAD can be tagged or untagged. PREAUTH and BYE are always untagged.',
    testability: { kind: 'parse' },
    note:
      'A tagging invariant: a tagged PREAUTH or BYE is malformed. Our parser flags ' +
      'it; the acceptTaggedPreauthBye defect is the negative control. (PREAUTH is a ' +
      'greeting; BYE is a broadcast — neither answers a specific command, so neither ' +
      'can carry a tag.)',
  },
  {
    id: 'R-9051-7.1-c',
    rfc: 'rfc9051',
    section: '7.1',
    page: 95,
    level: 'MAY',
    party: 'both',
    normativeSource: 'prose',
    text: 'A response code consists of data inside square brackets in the form of an atom, possibly followed by a space and arguments.',
    testability: { kind: 'parse' },
    note:
      'The OPTIONAL bracketed response code ("[READ-ONLY]", "[UIDVALIDITY 1]") that ' +
      'carries machine-actionable status beyond OK/NO/BAD. Our parser extracts the ' +
      'code atom and its arguments; the ignoreResponseCode defect (treat the bracket ' +
      'as plain text) is the negative control. MAY on the server side (it need not ' +
      'send one), but a client that fails to parse a present one loses the signal.',
  },
] as const satisfies readonly RequirementDef[];
