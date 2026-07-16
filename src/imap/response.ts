/**
 * A reference IMAP4rev2 server-response parser (RFC 9051 §2.2.2, §7.1), with
 * switchable defects.
 *
 * The read leg's most fundamental unit: a client dispatches on the first token of
 * each response line (a tag, "*", or "+") and reads the status condition and the
 * optional bracketed response code. This parser is the library-adapter analogue of
 * the message parsers — a correct-by-default reference with flags that each turn
 * off one rule, so the corpus can prove detection.
 *
 * Scope is one response line. Literals ({n} octet counts spanning lines), full
 * command parsing, and mailbox state are later increments. Bytes in, structured
 * out: a response line is ASCII in its framing, though its text can carry UTF-8.
 */

export type ResponseKind = 'tagged' | 'untagged' | 'continuation';
export type StatusCondition = 'OK' | 'NO' | 'BAD' | 'PREAUTH' | 'BYE';

const CONDITIONS: readonly string[] = ['OK', 'NO', 'BAD', 'PREAUTH', 'BYE'];

export interface ImapResponse {
  readonly kind: ResponseKind;
  /** The command tag, for a tagged response; null otherwise. */
  readonly tag: string | null;
  /** The status condition, if this response carries one (not all untagged data does). */
  readonly condition: StatusCondition | null;
  /** The response-code atom inside "[...]", if present and parsed. */
  readonly code: string | null;
  /** Arguments after the response-code atom, if any. */
  readonly codeArgs: string | null;
  /** The human-readable text (after any response code). */
  readonly text: string;
  readonly anomalies: readonly string[];
}

export interface ImapResponseDefects {
  /** Fail to recognise the "+" continuation as its own kind. Violates R-9051-2.2.2-a. */
  readonly treatPlusAsData?: boolean;
  /** Fail to recognise BYE as a status condition. Violates R-9051-7.1-a. */
  readonly dontRecognizeBye?: boolean;
  /** Do not flag a tagged PREAUTH/BYE (which are always untagged). Violates R-9051-7.1-b. */
  readonly acceptTaggedPreauthBye?: boolean;
  /** Treat a "[...]" response code as plain text. Violates R-9051-7.1-c. */
  readonly ignoreResponseCode?: boolean;
}

export function parseResponse(input: Buffer, defects: ImapResponseDefects = {}): ImapResponse {
  const line = input.toString('latin1').replace(/\r?\n$/, '');
  const sp = line.indexOf(' ');
  const firstToken = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1);

  // Command continuation request: "+" as the whole first token.
  if (firstToken === '+' && defects.treatPlusAsData !== true) {
    return { kind: 'continuation', tag: null, condition: null, code: null, codeArgs: null, text: rest, anomalies: [] };
  }

  let kind: ResponseKind;
  let tag: string | null;
  if (firstToken === '*') {
    kind = 'untagged';
    tag = null;
  } else {
    kind = 'tagged';
    tag = firstToken;
  }

  // Status condition (if the next token is one; untagged data like "5 EXISTS" is not).
  const recognized = new Set(CONDITIONS);
  if (defects.dontRecognizeBye === true) recognized.delete('BYE');
  const sp2 = rest.indexOf(' ');
  const condToken = (sp2 === -1 ? rest : rest.slice(0, sp2)).toUpperCase();
  let condition: StatusCondition | null = null;
  let remainder = rest;
  if (recognized.has(condToken)) {
    condition = condToken as StatusCondition;
    remainder = sp2 === -1 ? '' : rest.slice(sp2 + 1);
  }

  // Optional bracketed response code.
  let code: string | null = null;
  let codeArgs: string | null = null;
  let text = remainder;
  if (condition !== null && defects.ignoreResponseCode !== true && remainder.startsWith('[')) {
    const close = remainder.indexOf(']');
    if (close !== -1) {
      const inside = remainder.slice(1, close);
      const isp = inside.indexOf(' ');
      code = isp === -1 ? inside : inside.slice(0, isp);
      codeArgs = isp === -1 ? null : inside.slice(isp + 1);
      text = remainder.slice(close + 1).replace(/^ /, '');
    }
  }

  const anomalies: string[] = [];
  if ((condition === 'PREAUTH' || condition === 'BYE') && kind === 'tagged' && defects.acceptTaggedPreauthBye !== true) {
    anomalies.push('tagged-status-always-untagged');
  }

  return { kind, tag, condition, code, codeArgs, text, anomalies };
}

/** True if `kind` is present in the response anomalies. */
export function hasResponseAnomaly(r: ImapResponse, kind: string): boolean {
  return r.anomalies.includes(kind);
}
