/**
 * RFC 5321 §4.5.3.2 — Timeouts (and subsections 4.5.3.2.1 through 4.5.3.2.7)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Scope note: almost the whole section binds the SMTP *client* — it prescribes
 * the timeouts a sender must apply while waiting for the receiver's replies.
 * This suite connects *to* a server and observes only receiver behaviour, so
 * those client timeouts are registered but marked not-testable. The single
 * server-binding requirement is 4.5.3.2.7 (the idle-command timeout), which is
 * wire-observable in principle but expensive and full of latitude — see its note.
 *
 * The per-command minimum values in 4.5.3.2.1–4.5.3.2.6 have no keyword of their
 * own; their normative force comes from the parent sentence in 4.5.3.2, "the
 * minimum per-command timeout values SHOULD be as follows:" (registered as
 * R-5321-4.5.3.2-d). Each value is therefore recorded as `prose` at SHOULD level.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S4_5_3_2 = [
  {
    id: 'R-5321-4.5.3.2-a',
    section: '4.5.3.2',
    page: 65,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'An SMTP client MUST provide a timeout mechanism.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client. Whether a sender maintains a timeout mechanism ' +
        'is a property of the client, invisible to a server we connect to.',
    },
  },
  {
    id: 'R-5321-4.5.3.2-b',
    section: '4.5.3.2',
    page: 65,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'It MUST use per-command timeouts rather than somehow trying to time the ' +
      'entire mail transaction.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client. How a sender structures its timers (per-command ' +
        'vs. whole-transaction) is internal client behaviour, not observable ' +
        'from the receiving end of the connection.',
    },
  },
  {
    id: 'R-5321-4.5.3.2-c',
    section: '4.5.3.2',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Timeouts SHOULD be easily reconfigurable, preferably without recompiling ' +
      'the SMTP code.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client configurability/operability property. Reconfigurability of a ' +
        "sender's timeouts is an implementation and deployment concern with no " +
        'wire manifestation.',
    },
  },
  {
    id: 'R-5321-4.5.3.2-d',
    section: '4.5.3.2',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'Based on extensive experience with busy mail-relay hosts, the minimum ' +
      'per-command timeout values SHOULD be as follows:',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client: these are the minimum durations a sender should ' +
        'wait for each reply. They govern client patience, which a server cannot ' +
        'observe.',
    },
    note:
      'This is the umbrella SHOULD that gives normative force to the per-command ' +
      'values enumerated in 4.5.3.2.1 through 4.5.3.2.6. Each of those subsection ' +
      'values is registered separately (normativeSource: prose) and inherits its ' +
      'SHOULD level from this sentence. Note the "minimum" framing: a client that ' +
      'waits LONGER than these values is conformant; only waiting less would breach.',
  },
  {
    id: 'R-5321-4.5.3.2.1-a',
    section: '4.5.3.2.1',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'Initial 220 Message: 5 Minutes',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (5 minutes for the initial 220 greeting). ' +
        'Binds the sender; a server cannot observe how long a client is willing ' +
        'to wait for its own greeting.',
    },
    note:
      'PROSE: the subsection header carries only the value; its normative force ' +
      'is the parent SHOULD in R-5321-4.5.3.2-d. The surrounding paragraph ' +
      '("An SMTP client process needs to distinguish between a failed TCP ' +
      'connection and a delay...") is rationale, not a separate requirement, so ' +
      'it is not registered.',
  },
  {
    id: 'R-5321-4.5.3.2.2-a',
    section: '4.5.3.2.2',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'MAIL Command: 5 Minutes',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (5 minutes for the MAIL reply). Binds the ' +
        'sender; client patience is not observable from the server side.',
    },
    note:
      'PROSE: value only; force inherited from the parent SHOULD (R-5321-4.5.3.2-d).',
  },
  {
    id: 'R-5321-4.5.3.2.3-a',
    section: '4.5.3.2.3',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'RCPT Command: 5 Minutes',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (5 minutes for the RCPT reply). Binds the ' +
        'sender; client patience is not observable from the server side.',
    },
    note:
      'PROSE: value only; force inherited from the parent SHOULD (R-5321-4.5.3.2-d).',
  },
  {
    id: 'R-5321-4.5.3.2.3-b',
    section: '4.5.3.2.3',
    page: 65,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text:
      'A longer timeout is required if processing of mailing lists and aliases ' +
      'is not deferred until after the message was accepted.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the SMTP client: it conditions the length of the sender\'s RCPT ' +
        'timeout on the receiver\'s (unknowable) list/alias processing. Client ' +
        'timeout behaviour is not observable from the server side.',
    },
    note:
      'PROSE, and weak: "is required" reads as rationale explaining why RCPT gets ' +
      'the same 5-minute floor as MAIL rather than a fresh normative obligation. ' +
      'Registered separately for completeness and flagged here as borderline — a ' +
      'test author should not treat it as an independently assertable rule.',
  },
  {
    id: 'R-5321-4.5.3.2.4-a',
    section: '4.5.3.2.4',
    page: 66,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'DATA Initiation: 2 Minutes',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (2 minutes for the 354 reply to DATA). Binds ' +
        'the sender; not observable from the server side.',
    },
    note:
      'PROSE: value only; force inherited from the parent SHOULD (R-5321-4.5.3.2-d). ' +
      'The following sentence ("This is while awaiting the \\"354 Start Input\\" ' +
      'reply to a DATA command.") is definitional, not a separate requirement.',
  },
  {
    id: 'R-5321-4.5.3.2.5-a',
    section: '4.5.3.2.5',
    page: 66,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'Data Block: 3 Minutes',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (3 minutes per data block / TCP SEND). Binds ' +
        'the sender; not observable from the server side.',
    },
    note:
      'PROSE: value only; force inherited from the parent SHOULD (R-5321-4.5.3.2-d). ' +
      'The following sentence is definitional (defines what the timer covers).',
  },
  {
    id: 'R-5321-4.5.3.2.6-a',
    section: '4.5.3.2.6',
    page: 66,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'prose',
    text: 'DATA Termination: 10 Minutes.',
    testability: {
      kind: 'not-testable',
      reason:
        'A client-side minimum wait (10 minutes for the final 250 after the ' +
        'end-of-data dot). Binds the sender; not observable from the server side.',
    },
    note:
      'PROSE: value only; force inherited from the parent SHOULD (R-5321-4.5.3.2-d). ' +
      'Quoted with its trailing period as printed. The following paragraph ' +
      '(spurious-timeout / duplicate-delivery rationale, cross-referencing ' +
      'Section 6.1) is explanatory, not a separate requirement.',
  },
  {
    id: 'R-5321-4.5.3.2.7-a',
    section: '4.5.3.2.7',
    page: 66,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'An SMTP server SHOULD have a timeout of at least 5 minutes while it is ' +
      'awaiting the next command from the sender.',
    testability: { kind: 'wire' },
    note:
      'The one server-binding requirement in this section, and the one thing here ' +
      'we can actually observe. Read it as a FLOOR: after a successful command the ' +
      'server should keep an idle connection open for at least 5 minutes before ' +
      'timing it out. The observable breach is the server dropping an idle ' +
      'connection in LESS than 5 minutes; hold the connection idle just under 5 ' +
      'minutes and assert it is still open. ' +
      'Two traps: (1) it is a minimum, so a server that waits far longer — or ' +
      'effectively never times out on idle — is conformant; do NOT fail a server ' +
      'for being more patient than 5 minutes. (2) SHOULD, so even a shorter idle ' +
      'timeout is permitted-latitude, not a hard failure — though a very short one ' +
      'is worth surfacing. Also expensive: a faithful test needs a ~5-minute idle ' +
      'wait, so it depends on the harness tolerating long-running timeout probes.',
  },
] as const satisfies readonly RequirementDef[];
