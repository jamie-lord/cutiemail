/**
 * A multipart body splitter (RFC 2046 §5.1.1), with switchable defects.
 *
 * Given the raw body of a multipart entity and its boundary parameter, it splits
 * the body into parts, capturing the preamble and epilogue separately (they are
 * NOT parts). The rules it holds are the boundary-confusion defences: a delimiter
 * only counts at the start of a line, the whole boundary must match (not just a
 * prefix), and material outside the first/last delimiter is discarded. Each defect
 * reintroduces one confusion vector.
 *
 * Parts are returned as raw byte ranges; recursively parsing a part's own headers
 * (and nested multiparts) is a later increment — this establishes the split, which
 * is where boundary confusion lives. Bytes, never strings: the boundary is matched
 * as octets and the CRLF conceptually attached to a delimiter line is removed from
 * the preceding part, exactly as §5.1.1 specifies.
 */

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

export interface MultipartResult {
  /** Each body part's raw bytes (its own headers + body, unparsed). */
  readonly parts: readonly Buffer[];
  /** Bytes before the first delimiter — ignored per R-2046-5.1.1-b. */
  readonly preamble: Buffer;
  /** Bytes after the closing delimiter — ignored per R-2046-5.1.1-b. */
  readonly epilogue: Buffer;
  /** True if the closing "--boundary--" delimiter was seen. */
  readonly closed: boolean;
  readonly anomalies: readonly string[];
}

export interface MultipartDefects {
  /** Match a boundary anywhere on a line, not only at its start. Violates R-2046-5.1.1-a. */
  readonly matchBoundaryAnywhere?: boolean;
  /** Surface the preamble as a body part instead of discarding it. Violates R-2046-5.1.1-b. */
  readonly includePreambleAsPart?: boolean;
  /** Accept a boundary longer than 70 characters. Violates R-2046-5.1.1-c. */
  readonly acceptOverlongBoundary?: boolean;
  /** Accept a line whose token merely starts with the boundary. Violates R-2046-5.1.1-d. */
  readonly prefixBoundaryMatch?: boolean;
}

interface Line {
  readonly start: number; // first content octet
  readonly end: number; // one past last content octet (before CRLF/LF)
  readonly next: number; // index after the line terminator
}

/** Split into lines on CRLF (tolerating a bare LF), tracking exact offsets. */
function scanLines(buf: Buffer): Line[] {
  const lines: Line[] = [];
  let i = 0;
  while (i <= buf.length) {
    let j = i;
    while (j < buf.length && !(buf[j] === CR && buf[j + 1] === LF) && buf[j] !== LF) j++;
    let next: number;
    if (j < buf.length && buf[j] === CR && buf[j + 1] === LF) next = j + 2;
    else if (j < buf.length && buf[j] === LF) next = j + 1;
    else next = j;
    lines.push({ start: i, end: j, next });
    if (next === j) break; // reached end with no terminator
    i = next;
    if (i === buf.length) break; // terminator was the last thing in the buffer
  }
  return lines;
}

/** Trim trailing linear whitespace (SP/HT) from a byte range end index. */
function trimTrailingWsp(buf: Buffer, start: number, end: number): number {
  let e = end;
  while (e > start && (buf[e - 1] === 0x20 || buf[e - 1] === 0x09)) e--;
  return e;
}

export function parseMultipart(body: Buffer, boundary: string, defects: MultipartDefects = {}): MultipartResult {
  const anomalies: string[] = [];
  if (boundary.length > 70 && defects.acceptOverlongBoundary !== true) anomalies.push('overlong-boundary');

  const marker = Buffer.from(`--${boundary}`, 'latin1');
  const lines = scanLines(body);

  // Classify a line as a separator delimiter, the closing delimiter, or content.
  const classify = (ln: Line): 'sep' | 'close' | null => {
    const line = body.subarray(ln.start, ln.end);
    let idx: number;
    if (defects.matchBoundaryAnywhere === true) {
      idx = line.indexOf(marker);
      if (idx === -1) return null;
    } else {
      if (line.length < marker.length || !line.subarray(0, marker.length).equals(marker)) return null;
      idx = 0;
    }
    const restStart = idx + marker.length;
    const restEnd = trimTrailingWsp(line, restStart, line.length);
    const restLen = restEnd - restStart;
    if (restLen === 0) return 'sep';
    if (restLen === 2 && line[restStart] === DASH && line[restStart + 1] === DASH) return 'close';
    // The token continues past the boundary with something other than "--": not a
    // delimiter (R-2046-5.1.1-d), unless the prefix-match defect is on.
    if (defects.prefixBoundaryMatch === true) {
      return restLen >= 2 && line[restEnd - 1] === DASH && line[restEnd - 2] === DASH ? 'close' : 'sep';
    }
    return null;
  };

  const delims = lines.map((ln, i) => ({ i, kind: classify(ln) })).filter((d) => d.kind !== null);
  if (delims.length === 0) {
    // No boundary at all — the whole body is preamble; nothing structured.
    anomalies.push('no-boundary-found');
    return { parts: [], preamble: Buffer.from(body), epilogue: Buffer.alloc(0), closed: false, anomalies };
  }

  const firstDelim = delims[0]!;
  // Preamble: everything before the first delimiter line, minus the CRLF attached
  // to that delimiter line.
  let preEnd = lines[firstDelim.i]!.start;
  if (preEnd >= 2 && body[preEnd - 2] === CR && body[preEnd - 1] === LF) preEnd -= 2;
  const preamble = body.subarray(0, Math.max(0, preEnd));

  const parts: Buffer[] = [];
  let closed = false;
  let epilogue: Buffer = Buffer.alloc(0);

  for (let d = 0; d < delims.length; d++) {
    const cur = delims[d]!;
    if (cur.kind === 'close') {
      closed = true;
      epilogue = body.subarray(lines[cur.i]!.next);
      break;
    }
    // Separator: the part runs from just after this delimiter line to the start of
    // the next delimiter, minus the CRLF attached to the next delimiter.
    const next = delims[d + 1];
    if (next === undefined) {
      // Unterminated final part (no closing delimiter): take to end of body.
      parts.push(Buffer.from(body.subarray(lines[cur.i]!.next)));
      break;
    }
    let partEnd = lines[next.i]!.start;
    if (partEnd >= 2 && body[partEnd - 2] === CR && body[partEnd - 1] === LF) partEnd -= 2;
    parts.push(Buffer.from(body.subarray(lines[cur.i]!.next, Math.max(lines[cur.i]!.next, partEnd))));
  }

  if (!closed) anomalies.push('no-closing-delimiter');

  const finalParts = defects.includePreambleAsPart === true && preamble.length > 0 ? [Buffer.from(preamble), ...parts] : parts;

  return { parts: finalParts, preamble: Buffer.from(preamble), epilogue: Buffer.from(epilogue), closed, anomalies };
}

/** True if `kind` is present in the result anomalies. */
export function hasMultipartAnomaly(result: MultipartResult, kind: string): boolean {
  return result.anomalies.includes(kind);
}
