/**
 * Byte-literal construction for exact wire input.
 *
 * The design constraint that drives everything here: **there is no default line
 * terminator.** You cannot write a line without saying how it ends. `crlf` and
 * `lf` are different functions, so sending a bare LF is a deliberate act that
 * reads as one at the call site, and sending a correct CRLF is equally
 * deliberate. A DSL with an implicit terminator would make the smuggling corpus
 * either unwritable or — far worse — silently wrong, with tests that look like
 * they send malformed input and don't.
 *
 * The second constraint: **JS strings are UTF-16 and SMTP is octets.** Every
 * string here is encoded latin1, which maps U+0000-U+00FF to bytes 0x00-0xFF
 * exactly. A codepoint above U+00FF cannot be represented and would be silently
 * mangled — so it throws. If you want UTF-8 on the wire (SMTPUTF8 / RFC 6531
 * tests), say so with `utf8`, and the encoding is then visible at the call site
 * rather than assumed.
 *
 * Usage reads as the wire looks:
 *
 *   crlf`EHLO example.com`          -> 45 48 4c 4f ... 0d 0a
 *   lf`EHLO example.com`            -> 45 48 4c 4f ... 0a          (violation, on purpose)
 *   bare`EHLO example.com`          -> 45 48 4c 4f ...             (no terminator)
 *   cat(crlf`MAIL FROM:<a@b>`, crlf`RCPT TO:<c@d>`)
 *   b(0x0d, 0x0d, 0x0a)             -> CR CR LF
 */

/** What a template literal may interpolate. Buffers pass through untouched. */
export type Interpolatable = string | number | Buffer;

export const CR = 0x0d;
export const LF = 0x0a;
export const SP = 0x20;
export const HT = 0x09;
export const DOT = 0x2e;
export const NUL = 0x00;

export const CRLF: Buffer = Buffer.from([CR, LF]);
/** The end-of-DATA sequence, RFC 5321 §4.1.1.4. */
export const EOD: Buffer = Buffer.from([CR, LF, DOT, CR, LF]);

export class NonLatin1Error extends Error {
  constructor(ch: string, index: number) {
    super(
      `codepoint U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} ` +
        `at index ${index} cannot be a single octet. SMTP is 7-bit by default; ` +
        `use utf8\`...\` if you mean to send UTF-8 (RFC 6531), or b(...) for exact octets.`,
    );
    this.name = 'NonLatin1Error';
  }
}

/**
 * String -> octets, one char per byte.
 *
 * Throws above U+00FF rather than truncating. Node's latin1 encoder silently
 * masks to the low byte, which would turn a `日` in a test into a `å` on the
 * wire — a corrupted test that still passes. Silent corruption in a tool whose
 * purpose is byte fidelity is the worst available outcome.
 */
export function latin1(s: string): Buffer {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new NonLatin1Error(s[i]!, i);
  }
  return Buffer.from(s, 'latin1');
}

function part(v: Interpolatable): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new RangeError(`interpolated number must be an octet 0-255, got ${v}`);
    }
    return Buffer.from([v]);
  }
  return latin1(v);
}

function build(strings: TemplateStringsArray, vals: Interpolatable[], term: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < strings.length; i++) {
    out.push(latin1(strings[i]!));
    if (i < vals.length) out.push(part(vals[i]!));
  }
  if (term.length > 0) out.push(term);
  return Buffer.concat(out);
}

/** A line terminated by CRLF — the only terminator RFC 5321 §2.3.8 permits. */
export function crlf(strings: TemplateStringsArray, ...vals: Interpolatable[]): Buffer {
  return build(strings, vals, CRLF);
}

/**
 * A line terminated by a bare LF. **A deliberate §2.3.8 violation.**
 *
 * The primitive of the SMTP-smuggling corpus. A receiver that acts on this is
 * both non-conformant and the far end of a real attack — but note the finding
 * is in the DISAGREEMENT between two implementations, so classify what the
 * server does (honoured / rejected / normalised) rather than only pass/fail.
 */
export function lf(strings: TemplateStringsArray, ...vals: Interpolatable[]): Buffer {
  return build(strings, vals, Buffer.from([LF]));
}

/** A line terminated by a bare CR. Deliberate §2.3.8 violation. */
export function cr(strings: TemplateStringsArray, ...vals: Interpolatable[]): Buffer {
  return build(strings, vals, Buffer.from([CR]));
}

/** No terminator at all. For testing §2.4's "take no action until <CRLF>". */
export function bare(strings: TemplateStringsArray, ...vals: Interpolatable[]): Buffer {
  return build(strings, vals, Buffer.alloc(0));
}

/**
 * UTF-8 encoded, CRLF terminated. For SMTPUTF8 (RFC 6531) tests.
 *
 * Separate from `crlf` so that putting multi-byte characters on the wire is a
 * visible decision rather than an accident of encoding.
 */
export function utf8(strings: TemplateStringsArray, ...vals: Interpolatable[]): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < strings.length; i++) {
    out.push(Buffer.from(strings[i]!, 'utf8'));
    if (i < vals.length) {
      const v = vals[i]!;
      out.push(Buffer.isBuffer(v) ? v : typeof v === 'number' ? part(v) : Buffer.from(v, 'utf8'));
    }
  }
  out.push(CRLF);
  return Buffer.concat(out);
}

/** Exact octets. `b(0x0d, 0x0d, 0x0a)` -> CR CR LF. */
export function b(...octets: number[]): Buffer {
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 0xff) {
      throw new RangeError(`not an octet: ${o}`);
    }
  }
  return Buffer.from(octets);
}

/** Concatenate. Named `cat` because `concat` reads as Buffer.concat at a glance. */
export function cat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** `rep(0x78, 1000)` -> 1000 'x' octets. For §4.5.3.1 boundary tests. */
export function rep(octet: number, count: number): Buffer {
  if (!Number.isInteger(octet) || octet < 0 || octet > 0xff) {
    throw new RangeError(`not an octet: ${octet}`);
  }
  return Buffer.alloc(count, octet);
}

/**
 * Apply RFC 5321 §4.5.2 transparency to a message body.
 *
 * Any line beginning with a dot gets an extra dot. Deliberately NOT applied
 * automatically anywhere — half the DATA corpus exists to send *un*stuffed or
 * wrongly-stuffed content and observe what the server does with it.
 *
 * Operates on CRLF-delimited lines only, by design: if a body contains bare LFs
 * it is already violating §2.3.8 and "correct" stuffing of it is undefined. Do
 * that case by hand with `b()` and say in the test what you mean.
 */
export function dotStuff(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let start = 0;
  let atLineStart = true;
  for (let i = 0; i < body.length; i++) {
    if (atLineStart && body[i] === DOT) {
      out.push(body.subarray(start, i), Buffer.from([DOT]));
      start = i;
      atLineStart = false;
      continue;
    }
    if (body[i] === CR && body[i + 1] === LF) {
      atLineStart = true;
      i++;
      continue;
    }
    atLineStart = false;
  }
  out.push(body.subarray(start));
  return Buffer.concat(out);
}

/**
 * An annotated hex dump. This is what a human reads when triaging a failure, so
 * it renders CR/LF and the printable range explicitly — a mangled string in a
 * failure message is exactly how a byte-level bug hides.
 */
export function dump(buf: Buffer, label?: string): string {
  const lines: string[] = [];
  if (label !== undefined) lines.push(`${label} (${buf.length} octets)`);
  for (let off = 0; off < buf.length; off += 16) {
    const chunk = buf.subarray(off, off + 16);
    const hex: string[] = [];
    let ascii = '';
    for (const byte of chunk) {
      hex.push(byte.toString(16).padStart(2, '0'));
      ascii +=
        byte === CR ? '␍' : byte === LF ? '␊' : byte === HT ? '␉' : byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·';
    }
    const hexCol = hex.join(' ').padEnd(47, ' ');
    lines.push(`${off.toString(16).padStart(4, '0')}  ${hexCol}  |${ascii}|`);
  }
  if (buf.length === 0) lines.push('      <empty>');
  return lines.join('\n');
}

/** One-line rendering for terse assertion messages. */
export function show(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    out +=
      byte === CR
        ? '\\r'
        : byte === LF
          ? '\\n'
          : byte === HT
            ? '\\t'
            : byte >= 0x20 && byte <= 0x7e
              ? String.fromCharCode(byte)
              : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}
