/**
 * A reference RFC 5322 message parser, with switchable defects.
 *
 * This plays the same role for the message-format register that the mutant SMTP
 * server plays for the SMTP register: it is the implementation the conformance
 * corpus runs against, `defects` off (conformant baseline) and on (each defect the
 * exact violation a case must catch). A corpus case that has never been shown to
 * FAIL against a defective parser is faith, not evidence.
 *
 * It is deliberately built on the raw byte layer — no string splitting, no
 * TextDecoder — so a defect like "treat a bare LF as a line terminator" is
 * expressible at the octet level, which a string-based parser would paper over.
 * It also seeds the real server parser: there is no separate "mail library".
 *
 * Scope: it finds message STRUCTURE (lines, the header/body boundary, header
 * fields, folding) and records anomalies without normalising them. Header-value
 * decoding (RFC 2047, MIME) is a later, explicit layer.
 */

import type { Message, Header, Anomaly } from './model.ts';

const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;
const COLON = 0x3a;
const SP = 0x20;
const HTAB = 0x09;
const MAX_LINE = 998; // R-5322-2.1.1-a, excluding CRLF

/** Defects that make the parser violate a specific message-format requirement. */
export interface ParserDefects {
  /** Do not record the line-over-998 anomaly. Violates detection of R-5322-2.1.1-a. */
  readonly dontFlagOverlongLine?: boolean;
  /** Silently accept NUL / 8-bit octets (record no anomaly). Violates R-5322-2.1-a. */
  readonly acceptNonAsciiSilently?: boolean;
  /**
   * Treat a bare-LF EMPTY line as the header/body separator, not only a CRLF one.
   * Violates R-5322-2.1-b and is a header-injection / smuggling vector: a header
   * after a bare-LF blank line escapes into the body (or vice versa).
   */
  readonly splitHeaderBodyOnBareLf?: boolean;
}

interface PhysLine {
  readonly content: Buffer; // bytes before the terminator
  readonly terminator: 'crlf' | 'lf' | 'none';
  readonly lineNo: number; // 1-based
  readonly bodyOffset: number; // byte index immediately after this line's terminator
}

/** Split into physical lines on LF, classifying each terminator. Bytes only. */
function scanLines(buf: Buffer): PhysLine[] {
  const lines: PhysLine[] = [];
  let start = 0;
  let lineNo = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      lineNo++;
      let end = i;
      let terminator: 'crlf' | 'lf' = 'lf';
      if (end > start && buf[end - 1] === CR) {
        end -= 1;
        terminator = 'crlf';
      }
      lines.push({ content: buf.subarray(start, end), terminator, lineNo, bodyOffset: i + 1 });
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lineNo++;
    lines.push({ content: buf.subarray(start), terminator: 'none', lineNo, bodyOffset: buf.length });
  }
  return lines;
}

const isWsp = (b: number | undefined): boolean => b === SP || b === HTAB;

export function parseMessage(input: Buffer, defects: ParserDefects = {}): Message {
  const lines = scanLines(input);
  const anomalies: Anomaly[] = [];

  // Per-line octet-level anomalies (recorded across the whole message).
  for (const l of lines) {
    if (!defects.dontFlagOverlongLine && l.content.length > MAX_LINE) {
      anomalies.push({ kind: 'line-over-998', line: l.lineNo });
    }
    if (l.terminator === 'lf') anomalies.push({ kind: 'bare-lf', line: l.lineNo });
    if (!defects.acceptNonAsciiSilently) {
      let flaggedNul = false;
      let flagged8 = false;
      for (const b of l.content) {
        if (b === NUL && !flaggedNul) {
          anomalies.push({ kind: 'nul-octet', line: l.lineNo });
          flaggedNul = true;
        } else if (b >= 0x80 && !flagged8) {
          anomalies.push({ kind: 'eight-bit', line: l.lineNo });
          flagged8 = true;
        }
        // A CR inside the content (not consumed as a CRLF terminator) is a bare CR.
        if (b === CR) anomalies.push({ kind: 'bare-cr', line: l.lineNo });
      }
    }
  }

  // The header/body boundary: the first EMPTY line. Conformant = only a CRLF-
  // terminated empty line counts; the defect also accepts a bare-LF empty line.
  const isBoundary = (l: PhysLine): boolean =>
    l.content.length === 0 &&
    (l.terminator === 'crlf' || (defects.splitHeaderBodyOnBareLf === true && l.terminator === 'lf'));

  const boundaryIdx = lines.findIndex(isBoundary);
  const headerLines = boundaryIdx === -1 ? lines : lines.slice(0, boundaryIdx);
  const body =
    boundaryIdx === -1 ? Buffer.alloc(0) : input.subarray(lines[boundaryIdx]!.bodyOffset);
  if (boundaryIdx === -1) anomalies.push({ kind: 'no-empty-line', line: 0 });

  // Assemble header fields, honouring folding: a line starting with SP/HTAB
  // continues the previous field.
  const headers: Header[] = [];
  let cur: { name: Buffer; valueParts: Buffer[]; lineNo: number } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    headers.push({ name: cur.name, value: Buffer.concat(cur.valueParts) });
    cur = null;
  };
  for (const l of headerLines) {
    if (cur !== null && isWsp(l.content[0])) {
      // Folded continuation: keep the CRLF-equivalent and the continuation bytes,
      // so unfolding is the caller's choice and no information is lost.
      cur.valueParts.push(Buffer.from([CR, LF]), l.content);
      continue;
    }
    flush();
    const colon = l.content.indexOf(COLON);
    if (colon === -1) {
      // A header-section line with no colon (and not a fold) is malformed.
      if (l.content.length > 0) anomalies.push({ kind: 'header-no-colon', line: l.lineNo });
      continue;
    }
    const name = l.content.subarray(0, colon);
    const value = l.content.subarray(colon + 1);
    cur = { name, valueParts: [value], lineNo: l.lineNo };
  }
  flush();

  return { headers, body, anomalies };
}

/** Convenience for corpus assertions: does a header with this (case-insensitive) name exist? */
export function hasHeader(msg: Message, name: string): boolean {
  const want = name.toLowerCase();
  return msg.headers.some((h) => h.name.toString('latin1').trim().toLowerCase() === want);
}

/** Convenience: is an anomaly of this kind present? */
export function hasAnomaly(msg: Message, kind: Anomaly['kind']): boolean {
  return msg.anomalies.some((a) => a.kind === kind);
}
