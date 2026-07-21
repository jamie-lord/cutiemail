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
  /** Do not record a bare CR embedded in a line. Violates detection of R-5322-2.2-b. */
  readonly acceptEmbeddedCr?: boolean;
  /**
   * Do not flag a field name containing an octet outside printable US-ASCII
   * (33-126). Violates R-5322-2.2-a — the header-injection defence (a control or
   * space in a field name is how a smuggled header is disguised).
   */
  readonly acceptInvalidFieldNameChars?: boolean;
}

type Terminator = 'crlf' | 'lf' | 'none';
/** Callback per physical line, given by INDICES into buf ([start,end) is the content) so no
 * per-line object is allocated — the callback subarrays only when it actually needs the bytes. */
type LineFn = (buf: Buffer, start: number, end: number, terminator: Terminator, lineNo: number, bodyOffset: number) => void;

/**
 * Iterate physical lines (LF-split, terminator-classified, bytes only) WITHOUT retaining a
 * per-line object array AND without allocating a subarray per line — one callback per line by
 * index, so both memory and allocation stay O(1) in the line count.
 *
 * The prior version materialised a `PhysLine[]` over the ENTIRE message. A 25 MiB message
 * (the SIZE default) is ~13M lines ≈ ~2 GB of live objects, and the inbound path parses each
 * message THREE times (DKIM + DMARC + ARC), so one unauthenticated all-CRLF message stalled
 * the event loop for seconds and a few concurrent ones OOM-killed the process. The body region
 * is never turned into line objects.
 */
function forEachLine(buf: Buffer, cb: LineFn): void {
  let start = 0;
  let lineNo = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      lineNo++;
      let end = i;
      let terminator: Terminator = 'lf';
      if (end > start && buf[end - 1] === CR) {
        end -= 1;
        terminator = 'crlf';
      }
      cb(buf, start, end, terminator, lineNo, i + 1);
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lineNo++;
    cb(buf, start, buf.length, 'none', lineNo, buf.length);
  }
}

const isBoundaryLine = (len: number, terminator: Terminator, defects: ParserDefects): boolean =>
  len === 0 && (terminator === 'crlf' || (defects.splitHeaderBodyOnBareLf === true && terminator === 'lf'));

const isWsp = (b: number | undefined): boolean => b === SP || b === HTAB;

export function parseMessage(input: Buffer, defects: ParserDefects = {}): Message {
  const anomalies: Anomaly[] = [];

  // Pass 1: per-line octet-level anomalies (recorded across the whole message) + locate the
  // header/body boundary (the first EMPTY line). Streaming — no per-line array is retained, so
  // a 25 MiB body costs O(1) objects instead of ~2 GB.
  let boundaryBodyOffset = -1;
  forEachLine(input, (buf, start, end, terminator, lineNo, bodyOffset) => {
    const len = end - start;
    if (!defects.dontFlagOverlongLine && len > MAX_LINE) anomalies.push({ kind: 'line-over-998', line: lineNo });
    if (terminator === 'lf') anomalies.push({ kind: 'bare-lf', line: lineNo });
    if (!defects.acceptNonAsciiSilently) {
      let flaggedNul = false;
      let flagged8 = false;
      for (let j = start; j < end; j++) {
        const b = buf[j]!;
        if (b === NUL && !flaggedNul) {
          anomalies.push({ kind: 'nul-octet', line: lineNo });
          flaggedNul = true;
        } else if (b >= 0x80 && !flagged8) {
          anomalies.push({ kind: 'eight-bit', line: lineNo });
          flagged8 = true;
        }
      }
    }
    // A CR inside the content (not consumed as a CRLF terminator) is a bare CR — in a field
    // body, an injection vector (R-5322-2.2-b: no CR/LF except folding). Gated by its own defect.
    if (!defects.acceptEmbeddedCr) {
      for (let j = start; j < end; j++) {
        if (buf[j] === CR) {
          anomalies.push({ kind: 'bare-cr', line: lineNo });
          break;
        }
      }
    }
    if (boundaryBodyOffset === -1 && isBoundaryLine(len, terminator, defects)) boundaryBodyOffset = bodyOffset;
  });

  const body = boundaryBodyOffset === -1 ? Buffer.alloc(0) : input.subarray(boundaryBodyOffset);
  if (boundaryBodyOffset === -1) anomalies.push({ kind: 'no-empty-line', line: 0 });

  // Pass 2: assemble header fields from the lines BEFORE the boundary, honouring folding (a line
  // starting with SP/HTAB continues the previous field). Stops at the boundary line.
  const headers: Header[] = [];
  let cur: { name: Buffer; valueParts: Buffer[]; lineNo: number } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    headers.push({ name: cur.name, value: Buffer.concat(cur.valueParts) });
    cur = null;
  };
  let inHeaders = true;
  forEachLine(input, (buf, start, end, terminator, lineNo) => {
    if (!inHeaders) return;
    const len = end - start;
    if (isBoundaryLine(len, terminator, defects)) {
      inHeaders = false; // the boundary line itself is the separator, not a header
      return;
    }
    if (cur !== null && len > 0 && isWsp(buf[start])) {
      // Folded continuation: keep the CRLF-equivalent and the continuation bytes, so unfolding
      // is the caller's choice and no information is lost.
      cur.valueParts.push(Buffer.from([CR, LF]), buf.subarray(start, end));
      return;
    }
    flush();
    let colon = -1;
    for (let j = start; j < end; j++) {
      if (buf[j] === COLON) {
        colon = j;
        break;
      }
    }
    if (colon === -1) {
      // A header-section line with no colon (and not a fold) is malformed.
      if (len > 0) anomalies.push({ kind: 'header-no-colon', line: lineNo });
      return;
    }
    const name = buf.subarray(start, colon);
    // R-5322-2.2-a: a field name is printable US-ASCII 33-126, except colon (which ends it).
    // Anything else — a space, a control octet, an 8-bit byte — is a malformed/spoofed field
    // name and the disguise a smuggled header hides behind.
    if (!defects.acceptInvalidFieldNameChars && name.some((b) => b < 33 || b > 126)) {
      anomalies.push({ kind: 'field-name-invalid-char', line: lineNo });
    }
    cur = { name, valueParts: [buf.subarray(colon + 1, end)], lineNo };
  });
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
