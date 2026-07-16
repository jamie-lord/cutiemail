/**
 * DKIM canonicalization (RFC 6376 §3.4), with switchable defects.
 *
 * Four algorithms — {simple,relaxed} x {header,body} — that transform a message to
 * the octets a DKIM signature is computed over. Signer and verifier MUST agree
 * octet-for-octet, so these are pure, deterministic byte functions. The relaxed
 * variants are ordered whitespace recipes where a single wrong step silently breaks
 * every signature; the corpus pins them to the RFC 6376 §3.4.5 worked examples.
 *
 * Bytes, never strings: a header value or body can carry 8-bit octets (EAI), and
 * WSP handling is defined on octets (SP 0x20 / HTAB 0x09), so everything here is
 * Buffer-level.
 */

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HT = 0x09;
const COLON = 0x3a;

const isWsp = (b: number | undefined): boolean => b === SP || b === HT;

export interface CanonDefects {
  /** simple header: normalise whitespace (any change violates R-6376-3.4.1-a). */
  readonly simpleHeaderMutatesWhitespace?: boolean;
  /** relaxed header: do not lowercase the field name. Violates R-6376-3.4.2-a. */
  readonly relaxedHeaderKeepsCase?: boolean;
  /** relaxed header: do not collapse WSP runs to a single SP. Violates R-6376-3.4.2-b. */
  readonly relaxedHeaderKeepsWspRuns?: boolean;
  /** relaxed header: do not delete trailing WSP of the value. Violates R-6376-3.4.2-c. */
  readonly relaxedHeaderKeepsTrailingWsp?: boolean;
  /** simple body: do not reduce trailing empty lines to one CRLF. Violates R-6376-3.4.3-a. */
  readonly simpleBodyKeepsTrailingBlankLines?: boolean;
  /** relaxed body: do not strip trailing WSP on each line. Violates R-6376-3.4.4-a. */
  readonly relaxedBodyKeepsLineTrailingWsp?: boolean;
}

const crlf = (): Buffer => Buffer.from([CR, LF]);

/** Lowercase ASCII letters (A-Z) only; leave every other octet untouched. */
function lowerAscii(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c >= 0x41 && c <= 0x5a) out[i] = c + 0x20;
  }
  return out;
}

/** Collapse every run of one or more WSP octets to a single SP. */
function collapseWsp(bytes: number[]): number[] {
  const out: number[] = [];
  let inWsp = false;
  for (const b of bytes) {
    if (isWsp(b)) {
      if (!inWsp) out.push(SP);
      inWsp = true;
    } else {
      out.push(b);
      inWsp = false;
    }
  }
  return out;
}

// ---- Header canonicalization ----

/**
 * "simple" header: the field exactly as received (R-6376-3.4.1-a). `field` is the
 * whole field including its terminating CRLF and any folded continuation lines.
 */
export function simpleHeaderField(field: Buffer, defects: CanonDefects = {}): Buffer {
  if (defects.simpleHeaderMutatesWhitespace !== true) return Buffer.from(field);
  // Defect: normalise runs of WSP — a change "simple" is forbidden from making.
  return Buffer.from(collapseWsp([...field]));
}

/**
 * "relaxed" header: lowercase name, unfold, collapse WSP, strip value edges and
 * colon-adjacent WSP (R-6376-3.4.2-a/-b/-c). `field` is the whole field including
 * its terminating CRLF and any folded continuation lines.
 */
export function relaxedHeaderField(field: Buffer, defects: CanonDefects = {}): Buffer {
  const colon = field.indexOf(COLON);
  if (colon === -1) return Buffer.from(field); // not a well-formed field; leave it
  const nameRaw = field.subarray(0, colon);
  let value = [...field.subarray(colon + 1)];

  // Strip the field's own terminating CRLF.
  if (value.length >= 2 && value[value.length - 2] === CR && value[value.length - 1] === LF) value = value.slice(0, -2);
  // Unfold: a CRLF immediately followed by WSP is a fold — drop the CRLF, keep WSP.
  const unfolded: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === CR && value[i + 1] === LF && isWsp(value[i + 2])) {
      i += 1; // skip CR; the LF is skipped by the loop's next step
      continue;
    }
    if (value[i] === LF && i > 0 && value[i - 1] === CR && isWsp(value[i + 1])) continue; // the LF of a fold
    unfolded.push(value[i]!);
  }

  let v = defects.relaxedHeaderKeepsWspRuns === true ? unfolded : collapseWsp(unfolded);
  // Delete leading WSP (the WSP after the colon) always; trailing WSP unless the defect keeps it.
  while (v.length > 0 && isWsp(v[0])) v.shift();
  if (defects.relaxedHeaderKeepsTrailingWsp !== true) {
    while (v.length > 0 && isWsp(v[v.length - 1])) v.pop();
  }

  // Name: strip surrounding WSP, then lowercase (unless the defect keeps case).
  let name = [...nameRaw];
  while (name.length > 0 && isWsp(name[0])) name.shift();
  while (name.length > 0 && isWsp(name[name.length - 1])) name.pop();
  const nameBuf = defects.relaxedHeaderKeepsCase === true ? Buffer.from(name) : lowerAscii(Buffer.from(name));

  return Buffer.concat([nameBuf, Buffer.from([COLON]), Buffer.from(v), crlf()]);
}

// ---- Body canonicalization ----

/** Split a body into line-content Buffers on CRLF (DKIM assumes CRLF line endings). */
function splitLines(body: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i + 1 < body.length; i++) {
    if (body[i] === CR && body[i + 1] === LF) {
      lines.push(body.subarray(start, i));
      i += 1;
      start = i + 1;
    }
  }
  if (start < body.length) lines.push(body.subarray(start)); // trailing partial line (no CRLF)
  return lines;
}

/** "simple" body: reduce a run of trailing empty lines to a single CRLF (R-6376-3.4.3-a). */
export function simpleBody(body: Buffer, defects: CanonDefects = {}): Buffer {
  if (defects.simpleBodyKeepsTrailingBlankLines === true) return Buffer.from(body);
  // Strip all trailing CR/LF, then append exactly one CRLF (empty body -> "\r\n").
  let end = body.length;
  while (end > 0 && (body[end - 1] === CR || body[end - 1] === LF)) end--;
  return Buffer.concat([body.subarray(0, end), crlf()]);
}

/**
 * "relaxed" body: strip trailing WSP per line (R-6376-3.4.4-a), collapse intra-line
 * WSP runs, and ignore trailing empty lines. A non-empty result ends in one CRLF.
 */
export function relaxedBody(body: Buffer, defects: CanonDefects = {}): Buffer {
  const lines = splitLines(body).map((line) => {
    let bytes = collapseWsp([...line]);
    if (defects.relaxedBodyKeepsLineTrailingWsp !== true) {
      while (bytes.length > 0 && isWsp(bytes[bytes.length - 1])) bytes.pop();
    }
    return bytes;
  });
  // Ignore trailing empty lines.
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop();
  if (lines.length === 0) return Buffer.alloc(0);
  const out: number[] = [];
  for (const line of lines) {
    out.push(...line, CR, LF);
  }
  return Buffer.from(out);
}
