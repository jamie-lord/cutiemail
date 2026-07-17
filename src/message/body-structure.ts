/**
 * IMAP BODYSTRUCTURE / BODY construction (RFC 9051 §7.5.2).
 *
 * The MIME tree a FETCH BODYSTRUCTURE reports: each part's media type, its full
 * Content-Type parameter list (a client reads `name`/`filename` from here to show an
 * attachment), transfer encoding, octet size, and — for text — line count, recursing
 * through multipart containers. It composes the tested lower layers: parseMessage for
 * the header/body split and parseMultipart (RFC 2046 §5.1.1, boundary-confusion hard)
 * for the part split. This is the "recursively parse a part" increment those modules
 * left for later.
 *
 * Scope: multipart/* and single leaves are handled. A message/rfc822 part is emitted
 * as a basic leaf (its nested-ENVELOPE extended form is a later refinement). Content
 * is never decoded — sizes and encodings describe the ENCODED bytes, as the spec wants.
 */

import { parseMessage } from './parse.ts';
import { parseMultipart } from './multipart.ts';

interface BodyPart {
  readonly multipart: boolean;
  readonly type: string; // upper-cased for the wire, e.g. "TEXT"
  readonly subtype: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly id: string | null;
  readonly description: string | null;
  readonly encoding: string; // upper-cased, e.g. "7BIT"
  readonly size: number;
  readonly lines: number | null;
  readonly disposition: { readonly type: string; readonly params: ReadonlyArray<readonly [string, string]> } | null;
  readonly children: readonly BodyPart[];
}

/** Split a structured header value on top-level ';', ignoring ';' inside quotes. */
function splitSemicolons(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (inQuote) {
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === '"') inQuote = false;
      else cur += c;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse "value; a=b; c=\"d\"" into its first token and its full parameter list. */
function parseParameterized(value: string): { head: string; params: Array<readonly [string, string]> } {
  const parts = splitSemicolons(value);
  const params: Array<readonly [string, string]> = [];
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    if (name.length > 0) params.push([name, val]);
  }
  return { head: (parts[0] ?? '').trim(), params };
}

/** Unfolded first value of a header (case-insensitive), or null. */
function header(raw: Buffer, name: string): string | null {
  const { headers } = parseMessage(raw);
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower) return h.value.toString('latin1').replace(/\r\n(?=[ \t])/g, '').trim();
  }
  return null;
}

/** Count CRLF-terminated lines; a final unterminated line still counts. */
function countLines(body: Buffer): number {
  if (body.length === 0) return 0;
  let n = 0;
  for (let i = 0; i + 1 < body.length; i++) if (body[i] === 0x0d && body[i + 1] === 0x0a) n += 1;
  if (body[body.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Build the MIME part tree for a message or message part. */
export function buildBodyStructure(raw: Buffer): BodyPart {
  const { body } = parseMessage(raw);
  const ctRaw = header(raw, 'Content-Type') ?? 'text/plain';
  const { head: media, params } = parseParameterized(ctRaw);
  const slash = media.indexOf('/');
  const type = (slash === -1 ? 'text' : media.slice(0, slash)).toLowerCase();
  const subtype = (slash === -1 ? 'plain' : media.slice(slash + 1)).toLowerCase();
  const id = header(raw, 'Content-ID');
  const description = header(raw, 'Content-Description');
  const encoding = (header(raw, 'Content-Transfer-Encoding') ?? '7bit').toUpperCase();
  const dispRaw = header(raw, 'Content-Disposition');
  const disposition =
    dispRaw === null
      ? null
      : (() => {
          const d = parseParameterized(dispRaw);
          return { type: d.head.toLowerCase(), params: d.params };
        })();

  if (type === 'multipart') {
    const boundary = params.find(([n]) => n === 'boundary')?.[1] ?? '';
    const children = boundary === '' ? [] : parseMultipart(body, boundary).parts.map((p) => buildBodyStructure(p));
    return { multipart: true, type: 'MULTIPART', subtype: subtype.toUpperCase(), params, id, description, encoding, size: body.length, lines: null, disposition, children };
  }

  const lines = type === 'text' || (type === 'message' && subtype === 'rfc822') ? countLines(body) : null;
  return { multipart: false, type: type.toUpperCase(), subtype: subtype.toUpperCase(), params, id, description, encoding, size: body.length, lines, disposition, children: [] };
}

/** An IMAP quoted string, or NIL. CR/LF are stripped (they cannot appear in one). */
function qstr(s: string | null): string {
  return s === null ? 'NIL' : `"${s.replace(/[\r\n]+/g, ' ').replace(/([\\"])/g, '\\$1')}"`;
}

/** A parenthesised parameter list "(n v n v)", or NIL when empty. */
function paramList(params: ReadonlyArray<readonly [string, string]>): string {
  if (params.length === 0) return 'NIL';
  return `(${params.map(([n, v]) => `${qstr(n)} ${qstr(v)}`).join(' ')})`;
}

function serializeDisposition(d: BodyPart['disposition']): string {
  if (d === null) return 'NIL';
  return `(${qstr(d.type)} ${paramList(d.params)})`;
}

/**
 * Serialize a part to the IMAP wire form. `extended` (BODYSTRUCTURE) appends the
 * disposition/language/location fields; the basic form (BODY) omits them.
 */
function serialize(part: BodyPart, extended: boolean): string {
  if (part.multipart) {
    const kids = part.children.map((c) => serialize(c, extended)).join('');
    if (!extended) return `(${kids} ${qstr(part.subtype)})`;
    // BODYSTRUCTURE multipart: children, subtype, params, disposition, language, location.
    return `(${kids} ${qstr(part.subtype)} ${paramList(part.params)} ${serializeDisposition(part.disposition)} NIL NIL)`;
  }
  const base = `${qstr(part.type)} ${qstr(part.subtype)} ${paramList(part.params)} ${qstr(part.id)} ${qstr(part.description)} ${qstr(part.encoding)} ${part.size}`;
  const withLines = part.lines !== null ? `${base} ${part.lines}` : base;
  if (!extended) return `(${withLines})`;
  // BODYSTRUCTURE leaf: append md5, disposition, language, location.
  return `(${withLines} NIL ${serializeDisposition(part.disposition)} NIL NIL)`;
}

/**
 * Navigate a MIME part path (e.g. [1] or [2, 1]) to the entity (its own headers +
 * body) at that position, or null if the path does not resolve. A non-multipart
 * entity has a single implicit part numbered 1 (the entity itself). Used by
 * FETCH BODY[<part>] so a client can download just an attachment.
 */
export function resolvePart(raw: Buffer, path: readonly number[]): Buffer | null {
  let current = raw;
  for (let level = 0; level < path.length; level++) {
    const idx = path[level]!;
    const { body } = parseMessage(current);
    const { head: media, params } = parseParameterized(header(current, 'Content-Type') ?? 'text/plain');
    if (media.toLowerCase().startsWith('multipart/')) {
      const boundary = params.find(([n]) => n === 'boundary')?.[1] ?? '';
      if (boundary === '') return null;
      const parts = parseMultipart(body, boundary).parts;
      if (idx < 1 || idx > parts.length) return null;
      current = parts[idx - 1]!;
    } else {
      // A single-part entity: only part "1" exists and it is this entity's body.
      if (idx !== 1 || level !== path.length - 1) return null;
      return current;
    }
  }
  return current;
}

/** The FETCH BODY (non-extensible) response value for a message. */
export function bodyResponse(raw: Buffer): string {
  return serialize(buildBodyStructure(raw), false);
}

/** The FETCH BODYSTRUCTURE (extensible) response value for a message. */
export function bodyStructureResponse(raw: Buffer): string {
  return serialize(buildBodyStructure(raw), true);
}
