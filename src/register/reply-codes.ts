/**
 * The RFC 5321 reply-code registry — machine-readable §4.2.3 and §4.3.2.
 *
 * Two different assertions live here, and they are not the same strength:
 *
 *  - `REPLY_CODES` answers "is this a reply code RFC 5321 defines?" — the weak
 *    check. Every code in §4.2.3, with its meaning quoted verbatim.
 *
 *  - `COMMAND_REPLY_SEQUENCES` answers "may this code follow this command?" —
 *    the strong check, and the reason this file exists. §4.3.2 tabulates, per
 *    command, exactly which success and error codes are expected. A server that
 *    returns a grammatical, registered code that §4.3.2 does not list for the
 *    command it answered has still violated the sequencing rules. That is a far
 *    sharper conformance assertion than code validity alone.
 *
 * Every `meaning` is quoted verbatim from spec/rfc5321.txt §4.2.3 (RFC 5321,
 * Klensin, October 2008), line-wrapping collapsed to single spaces and nothing
 * else. The companion test checks each one against the vendored RFC so drift
 * into paraphrase is a test failure, not a silent lie.
 *
 * Provenance note on 451: §4.2.2 ("Reply Codes by Function Groups") prints it
 * as "Requested action aborted: error in processing" while §4.2.3 ("Reply Codes
 * in Numeric Order") prints "...local error in processing". The RFC contradicts
 * itself. This registry is built from §4.2.3, so the §4.2.3 wording is what is
 * quoted; see NOTES.
 *
 * Compatible with the reader in src/wire/reply.ts: a `Reply.code` number can be
 * looked up directly against `REPLY_CODES`, and `severity()`'s 2/3/4/5 class
 * lines up with the first digit here.
 */

/** A reply code as defined in RFC 5321 §4.2.3, "Reply Codes in Numeric Order". */
export interface ReplyCodeDef {
  /** The three-digit code as a number. */
  readonly code: number;
  /**
   * The meaning, quoted verbatim from §4.2.3. Line wrapping is collapsed to
   * single spaces; no other change. Angle-bracket placeholders (`<domain>`,
   * `<forward-path>`, `<CRLF>.<CRLF>`) are the RFC's own notation, kept as-is.
   */
  readonly meaning: string;
  /**
   * True for every entry: all are drawn from §4.2.3's numeric-order list. The
   * field documents provenance rather than distinguishing entries — it is here
   * so a corpus author can see, per row, that the source was the numeric-order
   * table and not the by-function-group table (§4.2.2), which differs (see 451).
   */
  readonly listedInNumericOrder: true;
}

/**
 * Every reply code in RFC 5321 §4.2.3, in the numeric order the RFC lists them.
 */
export const REPLY_CODES = [
  {
    code: 211,
    meaning: 'System status, or system help reply',
    listedInNumericOrder: true,
  },
  {
    code: 214,
    meaning:
      'Help message (Information on how to use the receiver or the meaning of a particular non-standard command; this reply is useful only to the human user)',
    listedInNumericOrder: true,
  },
  {
    code: 220,
    meaning: '<domain> Service ready',
    listedInNumericOrder: true,
  },
  {
    code: 221,
    meaning: '<domain> Service closing transmission channel',
    listedInNumericOrder: true,
  },
  {
    code: 250,
    meaning: 'Requested mail action okay, completed',
    listedInNumericOrder: true,
  },
  {
    code: 251,
    meaning: 'User not local; will forward to <forward-path> (See Section 3.4)',
    listedInNumericOrder: true,
  },
  {
    code: 252,
    meaning:
      'Cannot VRFY user, but will accept message and attempt delivery (See Section 3.5.3)',
    listedInNumericOrder: true,
  },
  {
    code: 354,
    meaning: 'Start mail input; end with <CRLF>.<CRLF>',
    listedInNumericOrder: true,
  },
  {
    code: 421,
    meaning:
      '<domain> Service not available, closing transmission channel (This may be a reply to any command if the service knows it must shut down)',
    listedInNumericOrder: true,
  },
  {
    code: 450,
    meaning:
      'Requested mail action not taken: mailbox unavailable (e.g., mailbox busy or temporarily blocked for policy reasons)',
    listedInNumericOrder: true,
  },
  {
    code: 451,
    meaning: 'Requested action aborted: local error in processing',
    listedInNumericOrder: true,
  },
  {
    code: 452,
    meaning: 'Requested action not taken: insufficient system storage',
    listedInNumericOrder: true,
  },
  {
    code: 455,
    meaning: 'Server unable to accommodate parameters',
    listedInNumericOrder: true,
  },
  {
    code: 500,
    meaning:
      'Syntax error, command unrecognized (This may include errors such as command line too long)',
    listedInNumericOrder: true,
  },
  {
    code: 501,
    meaning: 'Syntax error in parameters or arguments',
    listedInNumericOrder: true,
  },
  {
    code: 502,
    meaning: 'Command not implemented (see Section 4.2.4)',
    listedInNumericOrder: true,
  },
  {
    code: 503,
    meaning: 'Bad sequence of commands',
    listedInNumericOrder: true,
  },
  {
    code: 504,
    meaning: 'Command parameter not implemented',
    listedInNumericOrder: true,
  },
  {
    code: 550,
    meaning:
      'Requested action not taken: mailbox unavailable (e.g., mailbox not found, no access, or command rejected for policy reasons)',
    listedInNumericOrder: true,
  },
  {
    code: 551,
    meaning: 'User not local; please try <forward-path> (See Section 3.4)',
    listedInNumericOrder: true,
  },
  {
    code: 552,
    meaning: 'Requested mail action aborted: exceeded storage allocation',
    listedInNumericOrder: true,
  },
  {
    code: 553,
    meaning:
      'Requested action not taken: mailbox name not allowed (e.g., mailbox syntax incorrect)',
    listedInNumericOrder: true,
  },
  {
    code: 554,
    meaning:
      'Transaction failed (Or, in the case of a connection-opening response, "No SMTP service here")',
    listedInNumericOrder: true,
  },
  {
    code: 555,
    meaning: 'MAIL FROM/RCPT TO parameters not recognized or not implemented',
    listedInNumericOrder: true,
  },
] as const satisfies readonly ReplyCodeDef[];

/** The commands §4.3.2 gives command-reply sequences for. */
export type Command =
  | 'EHLO'
  | 'HELO'
  | 'MAIL'
  | 'RCPT'
  | 'DATA'
  | 'RSET'
  | 'VRFY'
  | 'EXPN'
  | 'HELP'
  | 'NOOP'
  | 'QUIT';

/**
 * One reply code as it appears in a §4.3.2 sequence, with the RFC's own
 * parenthetical caveat when it carries one.
 */
export interface SequencedReply {
  readonly code: number;
  /**
   * The verbatim parenthetical §4.3.2 attaches to this code in this position,
   * if any (e.g. 502 after EHLO/HELO is "permitted only with an old-style
   * server that does not support EHLO"). Quoted, not paraphrased.
   */
  readonly note?: string;
}

/**
 * The §4.3.2 command-reply sequence for one command.
 *
 * §4.3.2's prefixes: "I" intermediate, "S" success, "E" error. Only DATA has an
 * intermediate reply (354, requesting the message body). The `success` and
 * `error` arrays list exactly the codes §4.3.2 tabulates for the command — no
 * more. The always-available codes 500, 501 and 421 (see `ANY_COMMAND_REPLIES`)
 * are NOT repeated in each command's arrays; they apply on top of every one.
 */
export interface CommandReplySequenceDef {
  readonly command: Command;
  /** "I" replies. DATA only: 354, "Start mail input". */
  readonly intermediate?: readonly SequencedReply[];
  /** "S" replies — the success codes §4.3.2 lists for the command. */
  readonly success: readonly SequencedReply[];
  /** "E" replies — the error/failure codes §4.3.2 lists for the command. */
  readonly error: readonly SequencedReply[];
  /** Extraction judgement or a cross-reference to NOTES for a carve-out. */
  readonly note?: string;
}

/**
 * Per-command reply sequences, transcribed from RFC 5321 §4.3.2.
 *
 * §4.3.2 groups "EHLO or HELO" into a single entry; it is expanded here into two
 * identical rows so a lookup by command always hits. CONNECTION ESTABLISHMENT
 * (S: 220 / E: 554) is not a command and lives in `CONNECTION_ESTABLISHMENT`.
 */
export const COMMAND_REPLY_SEQUENCES = [
  {
    command: 'EHLO',
    success: [{ code: 250 }],
    error: [
      {
        code: 504,
        note: 'a conforming implementation could return this code only in fairly obscure cases',
      },
      { code: 550 },
      {
        code: 502,
        note: 'permitted only with an old-style server that does not support EHLO',
      },
    ],
    note: '§4.3.2 lists EHLO and HELO together under "EHLO or HELO"; split here for lookup.',
  },
  {
    command: 'HELO',
    success: [{ code: 250 }],
    error: [
      {
        code: 504,
        note: 'a conforming implementation could return this code only in fairly obscure cases',
      },
      { code: 550 },
      {
        code: 502,
        note: 'permitted only with an old-style server that does not support EHLO',
      },
    ],
    note: '§4.3.2 lists EHLO and HELO together under "EHLO or HELO"; split here for lookup.',
  },
  {
    command: 'MAIL',
    success: [{ code: 250 }],
    error: [
      { code: 552 },
      { code: 451 },
      { code: 452 },
      { code: 550 },
      { code: 553 },
      { code: 503 },
      { code: 455 },
      { code: 555 },
    ],
  },
  {
    command: 'RCPT',
    success: [
      { code: 250 },
      { code: 251, note: 'but see Section 3.4 for discussion of 251 and 551' },
    ],
    error: [
      { code: 550 },
      { code: 551 },
      { code: 552 },
      { code: 553 },
      { code: 450 },
      { code: 451 },
      { code: 452 },
      { code: 503 },
      { code: 455 },
      { code: 555 },
    ],
  },
  {
    command: 'DATA',
    // §4.3.2: "I: 354 -> data -> S: 250". The 354 requests the body; 250 is the
    // acceptance that follows the terminating <CRLF>.<CRLF>.
    intermediate: [{ code: 354 }],
    success: [{ code: 250 }],
    // Two distinct phases are flattened here; see NOTES.dataTwoPhase. The codes
    // 552, 554, 451, 452, 450, 550 answer the completed message body (after
    // <CRLF>.<CRLF>); 503 and 554 answer the DATA command itself (before any
    // body). 554 is the one code §4.3.2 lists in BOTH phases — deduplicated to a
    // single entry here.
    error: [
      { code: 552, note: 'after <CRLF>.<CRLF> (message body)' },
      {
        code: 554,
        note: 'listed in both phases: after <CRLF>.<CRLF>, and as an error to the DATA command itself (E: 503, 554)',
      },
      { code: 451, note: 'after <CRLF>.<CRLF> (message body)' },
      { code: 452, note: 'after <CRLF>.<CRLF> (message body)' },
      { code: 450, note: 'after <CRLF>.<CRLF> (rejections for policy reasons)' },
      { code: 550, note: 'after <CRLF>.<CRLF> (rejections for policy reasons)' },
      { code: 503, note: 'error to the DATA command itself (before body)' },
    ],
    note: 'DATA is two-phase; the reply codes valid after the body differ from those valid for the command. See §4.2.5 and NOTES.dataTwoPhase.',
  },
  {
    command: 'RSET',
    success: [{ code: 250 }],
    error: [],
  },
  {
    command: 'VRFY',
    success: [{ code: 250 }, { code: 251 }, { code: 252 }],
    error: [{ code: 550 }, { code: 551 }, { code: 553 }, { code: 502 }, { code: 504 }],
  },
  {
    command: 'EXPN',
    success: [{ code: 250 }, { code: 252 }],
    error: [{ code: 550 }, { code: 500 }, { code: 502 }, { code: 504 }],
  },
  {
    command: 'HELP',
    success: [{ code: 211 }, { code: 214 }],
    error: [{ code: 502 }, { code: 504 }],
  },
  {
    command: 'NOOP',
    success: [{ code: 250 }],
    error: [],
  },
  {
    command: 'QUIT',
    success: [{ code: 221 }],
    error: [],
  },
] as const satisfies readonly CommandReplySequenceDef[];

/**
 * CONNECTION ESTABLISHMENT from §4.3.2. Not a command — the server's greeting on
 * connect — but part of the same table, so registered for completeness.
 */
export const CONNECTION_ESTABLISHMENT = {
  success: [{ code: 220 }],
  error: [{ code: 554 }],
} as const satisfies { readonly success: readonly SequencedReply[]; readonly error: readonly SequencedReply[] };

/**
 * The codes §4.3.2 says "any SMTP command can return ... if the corresponding
 * unusual circumstances are encountered". These apply on top of every command's
 * own sequence and are deliberately NOT duplicated into each row above.
 *
 * `meaning` here is quoted verbatim from §4.3.2's own prose (which is longer and
 * different from the one-line §4.2.3 meanings — §4.3.2 explains when each fires).
 */
export const ANY_COMMAND_REPLIES = [
  {
    code: 500,
    meaning:
      'For the "command line too long" case or if the command name was not recognized. Note that producing a "command not recognized" error in response to the required subset of these commands is a violation of this specification. Similarly, producing a "command too long" message for a command line shorter than 512 characters would violate the provisions of Section 4.5.3.1.4.',
  },
  {
    code: 501,
    meaning:
      'Syntax error in command or arguments. In order to provide for future extensions, commands that are specified in this document as not accepting arguments (DATA, RSET, QUIT) SHOULD return a 501 message if arguments are supplied in the absence of EHLO-advertised extensions.',
  },
  {
    code: 421,
    meaning: 'Service shutting down and closing transmission channel',
  },
] as const satisfies readonly { readonly code: number; readonly meaning: string }[];

/**
 * The exceptions and carve-outs a corpus author must not get wrong. Each value
 * is verbatim RFC text where quoted, with the citation, so an assertion built on
 * one of these can point back at the spec.
 */
export const NOTES = {
  /**
   * §4.2.4 — when 502 rather than 500 or 252. Verbatim: the distinction is
   * *recognized-but-unimplemented* (502) vs *not recognized* (500), and the
   * EHLO advertisement constraint. The VRFY nuance: a server that does not
   * implement VRFY returns 502, but §3.5.3/§7.3 and the 252 code let it instead
   * answer 252 ("Cannot VRFY user, but will accept message and attempt
   * delivery") — 252 is a success (2yz), not the 502 unimplemented code, so a
   * server refusing to verify is NOT necessarily emitting 502.
   */
  code502:
    'Questions have been raised as to when reply code 502 (Command not implemented) SHOULD be returned in preference to other codes. 502 SHOULD be used when the command is actually recognized by the SMTP server, but not implemented. If the command is not recognized, code 500 SHOULD be returned. Extended SMTP systems MUST NOT list capabilities in response to EHLO for which they will return 502 (or 500) replies. [RFC 5321 §4.2.4]',

  /**
   * The VRFY-specific reading of §4.2.4, spelled out because it trips corpus
   * authors: three different codes can answer VRFY and only one is a failure.
   */
  vrfyNuance:
    'VRFY has three defensible replies: 250/251 (verified), 252 "Cannot VRFY user, but will accept message and attempt delivery" (a 2yz SUCCESS, not a refusal — see §3.5.3), and 502 only when the command is recognized but unimplemented. Do not assert 502 for a server that declines to verify; 252 is conformant. If VRFY is unrecognized entirely, §4.2.4 says 500, not 502.',

  /**
   * §4.2.5 — reply codes after the DATA-terminating <CRLF>.<CRLF> carry
   * *delivery responsibility semantics* that ordinary replies do not. A 2yz
   * here means the server has accepted responsibility for delivery; 4yz/5yz
   * mean it has not, and must not retry. This is why DATA's post-body replies
   * are modelled separately from its command-level replies.
   */
  dataAfterDotSemantics:
    'A positive completion (2yz) after DATA\'s <CRLF>.<CRLF> means the server "accepts responsibility for" delivering the message (or retrying, or returning a bounce). A 4yz means "it MUST NOT make a subsequent attempt to deliver that message" — responsibility stays with the client. A 5yz means "it MUST NOT make any subsequent attempt to deliver the message". [RFC 5321 §4.2.5]',

  /**
   * Why COMMAND_REPLY_SEQUENCES.DATA has two error groups. §4.3.2 lists DATA as
   * "I: 354 -> data -> S: 250" plus errors in two positions: after the body
   * (552, 554, 451, 452; 450, 550 for policy) and to the command itself
   * (E: 503, 554). Asserting "code X is valid after DATA" must specify which
   * phase — a 354 is only valid as the immediate reply to the DATA verb, and a
   * 503 ("bad sequence") only before a body, never after <CRLF>.<CRLF>.
   */
  dataTwoPhase:
    'DATA has two reply phases. Immediately after the DATA verb: I:354 (proceed) or E:503,554 (reject the command). After the message body\'s <CRLF>.<CRLF>: S:250 or E:552,554,451,452 and 450,550 (policy). Code 554 appears in both phases; 354 only in the first; 503 only in the first. Assert against the correct phase.',

  /**
   * The 451 wording discrepancy between §4.2.2 and §4.2.3. This registry quotes
   * §4.2.3 per the task; flagged so no one "corrects" it to the §4.2.2 form.
   */
  code451Discrepancy:
    '451\'s meaning differs between §4.2.2 "Requested action aborted: error in processing" and §4.2.3 "Requested action aborted: local error in processing". REPLY_CODES quotes §4.2.3 (the numeric-order table). Do not reconcile them — the RFC itself does not.',

  /**
   * §4.3.2's own governing caveat: clients interpret the first digit and must
   * cope with unlisted codes. A corpus assertion of "code not in the §4.3.2 set"
   * is a conformance observation about the server, not a hard protocol error the
   * client may reject on.
   */
  firstDigitRule:
    'SMTP clients SHOULD "interpret only the first digit of the reply and MUST be prepared to deal with unrecognized reply codes by interpreting the first digit only." Servers "MUST NOT transmit reply codes ... other than three digits or that do not start in a digit between 2 and 5 inclusive." A code outside a command\'s §4.3.2 set is a sequencing deviation to record, not necessarily a code the client rejects. [RFC 5321 §4.3.2]',
} as const;
