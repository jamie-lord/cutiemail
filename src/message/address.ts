/**
 * An opinionated, modern addr-spec parser/validator (RFC 5322 §3.4.1), with
 * switchable defects.
 *
 * Scope is the ADR-0007 cut: accept the dot-atom / quoted-string / address-literal
 * forms modern mail actually uses; REJECT the obsolete long tail — comments, folding
 * white space inside an address, obs-local-part / obs-domain. That is stricter than
 * RFC 5322 (which keeps the obsolete forms for backward compat) and deliberately so:
 * a smaller grammar is a smaller confusion surface. This is where "email address
 * parsing is impossible" gets tamed by refusing to try to parse the impossible bits.
 *
 * Bytes, never strings: a local-part can carry 8-bit octets under SMTPUTF8, so the
 * parts are Buffers and the validation is octet-level.
 */

const AT = 0x40; // '@'
const DOT = 0x2e; // '.'
const DQUOTE = 0x22; // '"'
const MAX_LOCAL = 64; // RFC 5321 §4.5.3.1.1
const MAX_DOMAIN = 255; // RFC 5321 §4.5.3.1.2

/** RFC 5322 atext: ALPHA / DIGIT / these specials. */
function isAtext(b: number): boolean {
  if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)) return true;
  return "!#$%&'*+-/=?^_`{|}~".split('').some((c) => c.charCodeAt(0) === b);
}

export interface AddrSpec {
  readonly localPart: Buffer;
  readonly domain: Buffer;
  /** Non-fatal observations (e.g. a quoted local-part — legal but discouraged). */
  readonly anomalies: readonly string[];
}

export type AddressResult =
  | { readonly ok: true; readonly addr: AddrSpec }
  | { readonly ok: false; readonly reason: string };

export interface AddressDefects {
  /** Accept an empty local-part or domain. Violates R-5322-3.4.1-a. */
  readonly acceptEmptySides?: boolean;
  /** Accept a non-atext octet (space, control, comment) in a dot-atom local-part. */
  readonly acceptInvalidLocalChars?: boolean;
  /** Accept a local-part longer than 64 octets. Violates the RFC 5321 floor. */
  readonly acceptOverlongLocalPart?: boolean;
}

/** LDH: the hostname alphabet — letters, digits, hyphen (RFC 5321 §4.1.2 sub-domain). */
function isLdh(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d;
}

/**
 * Validate a domain as dot-separated LDH labels: each non-empty, LDH-only, and NOT
 * starting or ending with a hyphen. This is the hostname grammar modern mail uses —
 * stricter than the atext dot-atom (which would pass "-iana.org" and "iana-.com"), and
 * the reason those are rejected. Address literals ("[...]") are validated separately.
 */
function domainError(domain: Buffer): string | null {
  if (domain[0] === DOT || domain[domain.length - 1] === DOT) return 'leading or trailing dot';
  const labels: number[][] = [[]];
  for (const b of domain) {
    if (b === DOT) labels.push([]);
    else labels[labels.length - 1]!.push(b);
  }
  for (const label of labels) {
    if (label.length === 0) return 'empty label';
    if (label[0] === 0x2d || label[label.length - 1] === 0x2d) return 'label starts or ends with a hyphen';
    for (const b of label) if (!isLdh(b)) return 'non-LDH octet in domain';
  }
  return null;
}

/** Validate a dot-atom: non-empty atext runs separated by single dots, no edge dots. */
function dotAtomError(part: Buffer, allowInvalidChars: boolean): string | null {
  if (part.length === 0) return 'empty';
  if (part[0] === DOT || part[part.length - 1] === DOT) return 'leading or trailing dot';
  let prevDot = false;
  for (const bch of part) {
    if (bch === DOT) {
      if (prevDot) return 'consecutive dots';
      prevDot = true;
    } else {
      if (!allowInvalidChars && !isAtext(bch)) return 'non-atext character';
      prevDot = false;
    }
  }
  return null;
}

export function parseAddrSpec(input: Buffer, defects: AddressDefects = {}): AddressResult {
  const anomalies: string[] = [];

  // Split local "@" domain. A leading quoted-string local-part is the one place an
  // @ may hide; otherwise the (single) @ is the separator. We reject a quoted local
  // that is not properly closed rather than parsing around it.
  let atIndex: number;
  let quotedLocal = false;
  if (input[0] === DQUOTE) {
    quotedLocal = true;
    anomalies.push('quoted-local-part'); // legal (R-5322-3.4.1-b prefers dot-atom), surfaced
    let i = 1;
    let closed = -1;
    for (; i < input.length; i++) {
      const c = input[i]!;
      if (c === 0x5c) {
        // quoted-pair: "\" then a printable ASCII octet (VCHAR/WSP, %d32-126). An escaped
        // control or 8-bit octet (e.g. "\<0xa9>") is not a valid quoted-pair.
        const next = input[i + 1];
        if (next === undefined) return { ok: false, reason: 'unterminated quoted-pair in local-part' };
        if (!(next >= 0x20 && next <= 0x7e)) return { ok: false, reason: 'invalid quoted-pair in local-part' };
        i++; // skip the escaped octet
      } else if (c === DQUOTE) {
        closed = i;
        break;
      } else if (c < 0x20 || c === 0x7f) {
        // qtext excludes control octets (a raw NUL/CR/LF inside the quotes is illegal).
        return { ok: false, reason: 'control octet in quoted local-part' };
      }
    }
    if (closed === -1) return { ok: false, reason: 'unterminated quoted local-part' };
    if (input[closed + 1] !== AT) return { ok: false, reason: 'quoted local-part not followed by "@"' };
    atIndex = closed + 1;
  } else {
    const first = input.indexOf(AT);
    const last = input.lastIndexOf(AT);
    if (first === -1) return { ok: false, reason: 'no "@" in addr-spec' };
    if (first !== last) return { ok: false, reason: 'more than one "@" (obsolete/exotic form rejected)' };
    atIndex = first;
  }

  const localPart = input.subarray(0, atIndex);
  const domain = input.subarray(atIndex + 1);

  if (!defects.acceptEmptySides) {
    if (localPart.length === 0) return { ok: false, reason: 'empty local-part' };
    if (domain.length === 0) return { ok: false, reason: 'empty domain' };
  }
  if (!defects.acceptOverlongLocalPart && localPart.length > MAX_LOCAL) {
    return { ok: false, reason: `local-part exceeds ${MAX_LOCAL} octets` };
  }
  if (domain.length > MAX_DOMAIN) return { ok: false, reason: `domain exceeds ${MAX_DOMAIN} octets` };

  // Local-part validation: dot-atom (unless quoted, which we accepted above). Only
  // on a non-empty part — an empty local-part is the acceptEmptySides gate's job,
  // above, so the defect can actually bypass it.
  if (!quotedLocal && localPart.length > 0) {
    const err = dotAtomError(localPart, defects.acceptInvalidLocalChars === true);
    if (err !== null) return { ok: false, reason: `invalid local-part: ${err}` };
  }

  // Domain validation: an address-literal "[...]" or a dot-atom of DNS labels.
  if (domain.length > 0) {
    if (domain[0] === 0x5b /* [ */) {
      if (domain[domain.length - 1] !== 0x5d /* ] */) return { ok: false, reason: 'unterminated address-literal' };
      // dcontent excludes "[", "]" and "\" (RFC 5321 §4.1.2): a nested/extra bracket or a
      // backslash is a malformed literal, e.g. "[RFC-5322-[domain-literal]".
      for (let i = 1; i < domain.length - 1; i++) {
        const b = domain[i]!;
        if (b === 0x5b || b === 0x5d || b === 0x5c) return { ok: false, reason: 'invalid octet in address-literal' };
      }
    } else {
      const err = domainError(domain);
      if (err !== null) return { ok: false, reason: `invalid domain: ${err}` };
    }
  }

  return { ok: true, addr: { localPart, domain, anomalies } };
}
