/**
 * The SMTP reply reader — an instrument, not a parser.
 *
 * A normal client parses replies to act on them, and is right to be liberal:
 * repair what you can, get the mail through. This reader has the opposite job.
 * Every deviation from RFC 5321 §4.2's grammar is *evidence*, so nothing is
 * repaired, nothing is normalised, and malformed input is a first-class outcome
 * rather than a thrown error. What a normal client would silently forgive, this
 * records as an `Anomaly`.
 *
 * The grammar being enforced (RFC 5321 §4.2, verbatim ABNF):
 *
 *   Reply-line  = *( Reply-code "-" [ textstring ] CRLF )
 *                 Reply-code [ SP textstring ] CRLF
 *   Reply-code  = %x32-35 %x30-35 %x30-39
 *   textstring  = 1*(%d09 / %d32-126)   ; HT, SP, Printable US-ASCII
 *
 * Three consequences that are easy to miss and worth stating:
 *
 * 1. **The second digit is bounded 0-5.** `%x30-35`. A `260` or `275` reply is
 *    not merely unusual, it is ungrammatical. Most clients never notice.
 *
 * 2. **The spec contradicts itself about the text.** The prose says "Formally, a
 *    reply is defined to be the sequence: a three-digit code, <SP>, one line of
 *    text, and <CRLF>" and calls omitting the text a violation ("Since, in
 *    violation of this specification, the text is sometimes not sent..."), while
 *    the ABNF says `[ SP textstring ]` — optional. Both readings are defensible
 *    from the same section. We record `no-text` / `bare-code` as anomalies and
 *    let the expectation layer decide severity; we do NOT get to resolve an
 *    ambiguity the IETF hasn't. Candidate for a bisNote (task #3).
 *
 * 3. **`textstring` is 7-bit.** `%d09 / %d32-126`. An 8-bit octet in reply text
 *    is ungrammatical, which matters because reply text is where servers most
 *    often leak a raw UTF-8 hostname or an unencoded local-part.
 *
 * We accept a bare-LF-terminated reply and flag it, rather than refusing to
 * frame it. That is not hypocrisy about §2.3.8: a receiver honouring a bare LF
 * from a *client* is a vulnerability, whereas an instrument recognising one from
 * a *server* is how the violation gets observed at all. Refusing to read it
 * would just hang.
 */

import type { Framer } from './transport.ts';

export type AnomalyKind =
  /** Reply-code digits violate %x32-35 %x30-35 %x30-39. */
  | 'code-out-of-grammar'
  /** Line ended with bare LF. RFC 5321 §2.3.8 forbids it as a terminator. */
  | 'bare-lf-terminator'
  /** Line ended with a bare CR not followed by LF. */
  | 'bare-cr-terminator'
  /** Final line was `NNN` with no space and no text. */
  | 'bare-code'
  /** Final line was `NNN ` — space present, text empty. */
  | 'empty-text'
  /** Byte outside HT / %d32-126 in textstring. */
  | 'non-ascii-in-text'
  /** A continuation line's code differs from the final line's code. */
  | 'continuation-code-mismatch'
  /** Reply line exceeded the 512-octet limit of RFC 5321 §4.5.3.1.5. */
  | 'reply-line-too-long'
  /** A digit follows the three code bytes: the code is longer than three digits (§4.3.2-c). */
  | 'code-not-three-digits'
  /** Separator after the code was neither SP nor '-'. */
  | 'malformed-separator';

export interface Anomaly {
  readonly kind: AnomalyKind;
  /** Which physical line of the reply, 0-based. */
  readonly line: number;
  /** Human-facing detail; the raw bytes remain on the Reply for real evidence. */
  readonly detail: string;
}

export type Terminator = 'crlf' | 'lf' | 'cr';

export interface ReplyLine {
  /** The three code bytes exactly as received. */
  readonly codeBytes: Buffer;
  /** '-' continuation, ' ' final, '' when the code stood alone. */
  readonly separator: '-' | ' ' | '';
  /** Text after the separator, exclusive of the terminator. May be empty. */
  readonly text: Buffer;
  readonly terminator: Terminator;
}

/** RFC 3463 enhanced status code, when the text starts with one. */
export interface EnhancedStatus {
  readonly class: number;
  readonly subject: number;
  readonly detail: number;
  readonly raw: Buffer;
}

export interface Reply {
  /**
   * The code as a number, taken from the FINAL line.
   *
   * Present even when ungrammatical — a `260` reply still has a number, and
   * discarding it would lose the evidence. Check `anomalies` before trusting it.
   */
  readonly code: number;
  readonly lines: readonly ReplyLine[];
  /** From the final line's text, if present. */
  readonly enhanced: EnhancedStatus | null;
  /** Exactly the bytes consumed from the wire. The evidence of record. */
  readonly raw: Buffer;
  readonly anomalies: readonly Anomaly[];
  /** True for `NNN-` continuations followed by a final line. */
  readonly multiline: boolean;
}

const HT = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HYPHEN = 0x2d;

/** RFC 5321 §4.5.3.1.5: "The maximum total length of a reply line ... is 512 octets". */
export const MAX_REPLY_LINE = 512;

/**
 * Guard against unbounded buffering from a server that never terminates a line.
 * Generous — well above the 512 limit — so that an over-long line is *observed*
 * and reported rather than silently truncated at the legal boundary.
 */
export const MAX_REPLY_BYTES = 64 * 1024;

export class ReplyTooLongError extends Error {}

function isTextByte(b: number): boolean {
  return b === HT || (b >= 0x20 && b <= 0x7e);
}

/** RFC 5321 §4.2 ABNF: %x32-35 %x30-35 %x30-39. */
function codeInGrammar(code: Buffer): boolean {
  if (code.length !== 3) return false;
  const [a, b, c] = [code[0]!, code[1]!, code[2]!];
  return a >= 0x32 && a <= 0x35 && b >= 0x30 && b <= 0x35 && c >= 0x30 && c <= 0x39;
}

/** Finds the end of the next physical line, honouring CRLF, bare LF, or bare CR. */
function findLineEnd(
  buf: Buffer,
  from: number,
  atEof = false,
): { end: number; term: Terminator } | null {
  for (let i = from; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === LF) return { end: i, term: 'lf' };
    if (b === CR) {
      if (i + 1 >= buf.length) {
        // A CR at the very end is ambiguous: CRLF or bare CR? Normally we wait
        // for the next byte. But at EOF (the peer closed), no next byte is
        // coming — so a trailing CR is a bare-CR terminator, and framing it is
        // how the bare-cr-terminator anomaly gets observed instead of dropped.
        return atEof ? { end: i, term: 'cr' } : null;
      }
      if (buf[i + 1] === LF) return { end: i, term: 'crlf' };
      return { end: i, term: 'cr' };
    }
  }
  return null;
}

function termLength(t: Terminator): number {
  return t === 'crlf' ? 2 : 1;
}

function parseEnhanced(text: Buffer): EnhancedStatus | null {
  // RFC 3463: class "." subject "." detail, at the start of the text, followed
  // by SP or end. Deliberately strict — a loose match here would invent
  // structure that isn't there.
  let i = 0;
  const digits = (): number | null => {
    const start = i;
    while (i < text.length && text[i]! >= 0x30 && text[i]! <= 0x39) i++;
    if (i === start) return null;
    return Number(text.subarray(start, i).toString('ascii'));
  };
  const cls = digits();
  if (cls === null || text[i] !== 0x2e) return null;
  i++;
  const subj = digits();
  if (subj === null || text[i] !== 0x2e) return null;
  i++;
  const det = digits();
  if (det === null) return null;
  if (i < text.length && text[i] !== SP) return null;
  if (cls !== 2 && cls !== 4 && cls !== 5) return null;
  return { class: cls, subject: subj, detail: det, raw: text.subarray(0, i) };
}

/**
 * Frames exactly one SMTP reply, complete with its anomalies.
 *
 * Returns null when more bytes are needed. Throws ReplyTooLongError only when a
 * server floods without terminating — a fault, not a conformance observation.
 */
function frame(buf: Buffer, atEof: boolean): { value: Reply; consumed: number } | null {
  const lines: ReplyLine[] = [];
  const anomalies: Anomaly[] = [];
  let offset = 0;

  for (;;) {
    const found = findLineEnd(buf, offset, atEof);
    if (found === null) {
      // Incomplete. Bound on BUFFERED length, not consumed offset: a server
      // flooding a single never-terminated line keeps offset at 0, so a guard on
      // offset would never fire. This is the real backstop against unbounded
      // buffering from a peer that never sends a terminator.
      if (buf.length >= MAX_REPLY_BYTES) {
        throw new ReplyTooLongError(`no reply terminator within ${MAX_REPLY_BYTES} bytes`);
      }
      return null; // wait for more
    }

    const lineNo = lines.length;
    const lineBytes = buf.subarray(offset, found.end);
    const consumedEnd = found.end + termLength(found.term);

    if (found.term === 'lf') {
      anomalies.push({
        kind: 'bare-lf-terminator',
        line: lineNo,
        detail: 'reply line terminated by LF without CR (RFC 5321 §2.3.8)',
      });
    } else if (found.term === 'cr') {
      anomalies.push({
        kind: 'bare-cr-terminator',
        line: lineNo,
        detail: 'reply line terminated by CR without LF (RFC 5321 §2.3.8)',
      });
    }

    // §4.5.3.1.5 counts the CRLF within the 512.
    const totalLineLength = lineBytes.length + termLength(found.term);
    if (totalLineLength > MAX_REPLY_LINE) {
      anomalies.push({
        kind: 'reply-line-too-long',
        line: lineNo,
        detail: `${totalLineLength} octets including terminator; RFC 5321 §4.5.3.1.5 permits 512`,
      });
    }

    const codeBytes = lineBytes.subarray(0, 3);
    // Count leading digit bytes to tell a SHORT code (fewer than 3 digits, e.g.
    // "25 Ok") from a three-digit code whose values are out of range (e.g. 260).
    // These are different requirements: too-few/too-many digits is §4.3.2-c
    // ("other than three digits"); a bad digit VALUE is the §4.2 ABNF.
    let leadingDigits = 0;
    while (leadingDigits < lineBytes.length && lineBytes[leadingDigits]! >= 0x30 && lineBytes[leadingDigits]! <= 0x39) {
      leadingDigits++;
    }
    if (leadingDigits < 3) {
      anomalies.push({
        kind: 'code-not-three-digits',
        line: lineNo,
        detail: `only ${leadingDigits} leading digit(s) before the separator; reply code has fewer than three digits (§4.3.2-c)`,
      });
    } else if (!codeInGrammar(codeBytes)) {
      // Exactly three (or more) leading digits, but a value is out of ABNF range.
      anomalies.push({
        kind: 'code-out-of-grammar',
        line: lineNo,
        detail:
          `"${codeBytes.toString('latin1')}" violates Reply-code = %x32-35 %x30-35 %x30-39 ` +
          `(first digit 2-5, second 0-5, third 0-9)`,
      });
    }

    const sepByte = lineBytes.length > 3 ? lineBytes[3]! : null;
    let separator: ReplyLine['separator'];
    let text: Buffer;

    if (sepByte === null) {
      separator = '';
      text = Buffer.alloc(0);
      anomalies.push({
        kind: 'bare-code',
        line: lineNo,
        detail:
          'code sent with no separator or text; §4.2 prose calls this a violation ' +
          '("senders SHOULD NOT send bare codes") though the ABNF permits [ SP textstring ]',
      });
    } else if (sepByte === HYPHEN) {
      separator = '-';
      text = lineBytes.subarray(4);
    } else if (sepByte === SP) {
      separator = ' ';
      text = lineBytes.subarray(4);
      if (text.length === 0) {
        anomalies.push({
          kind: 'empty-text',
          line: lineNo,
          detail: 'space present but textstring empty; ABNF requires 1*(%d09 / %d32-126)',
        });
      }
    } else if (sepByte >= 0x30 && sepByte <= 0x39) {
      // A DIGIT immediately after the three code bytes means the code is longer
      // than three digits (e.g. "2500"). This is the specific thing RFC 5321
      // §4.3.2-c forbids ("reply codes ... other than three digits"), distinct
      // from a merely malformed separator, so it gets its own anomaly.
      separator = '';
      text = lineBytes.subarray(3);
      anomalies.push({
        kind: 'code-not-three-digits',
        line: lineNo,
        detail: `a digit (0x${sepByte.toString(16)}) follows the three code bytes; reply code is longer than three digits (§4.3.2-c)`,
      });
    } else {
      separator = '';
      text = lineBytes.subarray(3);
      anomalies.push({
        kind: 'malformed-separator',
        line: lineNo,
        detail: `byte 0x${sepByte.toString(16).padStart(2, '0')} after code; expected SP or "-"`,
      });
    }

    for (const b of text) {
      if (!isTextByte(b)) {
        anomalies.push({
          kind: 'non-ascii-in-text',
          line: lineNo,
          detail: `byte 0x${b.toString(16).padStart(2, '0')} in textstring; ABNF permits HT and %d32-126 only`,
        });
        break;
      }
    }

    lines.push({ codeBytes: Buffer.from(codeBytes), separator, text: Buffer.from(text), terminator: found.term });
    offset = consumedEnd;

    // A hyphen means more lines follow. Anything else ends the reply — including
    // a malformed separator, since a client with no continuation marker has no
    // reason to keep waiting.
    if (separator !== '-') break;
  }

  const finalLine = lines[lines.length - 1]!;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.codeBytes.equals(finalLine.codeBytes)) {
      anomalies.push({
        kind: 'continuation-code-mismatch',
        line: i,
        detail:
          `continuation code "${lines[i]!.codeBytes.toString('latin1')}" differs from ` +
          `final "${finalLine.codeBytes.toString('latin1')}"`,
      });
    }
  }

  const code = Number.parseInt(finalLine.codeBytes.toString('latin1'), 10);

  return {
    value: {
      code: Number.isNaN(code) ? -1 : code,
      lines,
      enhanced: parseEnhanced(finalLine.text),
      raw: Buffer.from(buf.subarray(0, offset)),
      anomalies,
      multiline: lines.length > 1,
    },
    consumed: offset,
  };
}

/**
 * Frames exactly one SMTP reply. Returns null when more bytes are needed.
 */
export const replyFramer: Framer<Reply> = (buf) => frame(buf, false);

/**
 * EOF-aware framer: use on a partial buffer after the peer has CLOSED, so that a
 * final reply terminated by a bare CR (which the normal framer leaves pending,
 * waiting for a next byte that will never arrive) is framed and its
 * bare-cr-terminator anomaly observed rather than silently dropped. See the
 * pressure-test finding on reply.ts:145.
 */
export function frameReplyAtEof(buf: Buffer): { value: Reply; consumed: number } | null {
  return frame(buf, true);
}

/** First digit of the reply code — the severity class. Null when ungrammatical. */
export function severity(reply: Reply): 2 | 3 | 4 | 5 | null {
  const d = Math.floor(reply.code / 100);
  return d === 2 || d === 3 || d === 4 || d === 5 ? (d as 2 | 3 | 4 | 5) : null;
}

/**
 * ESMTP EHLO keywords defined by an RFC or the IANA registry that a HELO reply
 * would never legitimately carry. Used to tell an "EHLO-style" response
 * (advertising extensions) apart from a plain multiline prose banner — a HELO
 * server MAY send a multiline greeting, and "250 Have a nice day" must not be
 * mistaken for advertising a "HAVE" extension. Not exhaustive; erring toward
 * well-known keywords keeps false positives out.
 */
export const KNOWN_ESMTP_KEYWORDS: ReadonlySet<string> = new Set([
  'PIPELINING', 'SIZE', 'STARTTLS', '8BITMIME', 'AUTH', 'DSN', 'ENHANCEDSTATUSCODES',
  'CHUNKING', 'BINARYMIME', 'SMTPUTF8', 'VRFY', 'ETRN', 'HELP', 'EXPN', 'DELIVERBY',
  'ATRN', 'BURL', 'FUTURERELEASE', 'MT-PRIORITY', 'REQUIRETLS', 'NO-SOLICITING',
  'RRVS', 'CONNEG', 'CONPERM', 'MTRK', 'BODY',
]);

/** The recognised ESMTP keywords a reply actually advertises (subset of ehloKeywords). */
export function advertisedExtensions(reply: Reply): ReadonlySet<string> {
  const out = new Set<string>();
  for (const kw of ehloKeywords(reply)) {
    if (KNOWN_ESMTP_KEYWORDS.has(kw)) out.add(kw);
  }
  return out;
}

/** EHLO keywords from a multiline 250, uppercased. Empty when not an EHLO reply. */
export function ehloKeywords(reply: Reply): ReadonlySet<string> {
  const out = new Set<string>();
  // The first line of an EHLO reply is the greeting/domain, not a keyword.
  for (const line of reply.lines.slice(1)) {
    const text = line.text.toString('latin1').trim();
    if (text.length === 0) continue;
    const keyword = text.split(/\s+/)[0];
    if (keyword !== undefined && keyword.length > 0) out.add(keyword.toUpperCase());
  }
  return out;
}
