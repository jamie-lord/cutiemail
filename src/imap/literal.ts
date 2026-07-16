/**
 * IMAP literal detection (RFC 9051 §4.3), with a defect.
 *
 * Detects a trailing literal marker on a command line — "{n}" (synchronizing) or
 * "{n+}" (non-synchronizing) — and reports the octet count and which form it is, so
 * a server knows whether to send a "+" continuation request before reading the n
 * octets. Reading the octets themselves and re-parsing the completed command are
 * later increments; this is the framing decision.
 */

export interface LiteralInfo {
  /** True if the line ends with a literal marker. */
  readonly hasLiteral: boolean;
  /** The declared octet count, or null if no literal. */
  readonly octetCount: number | null;
  /** True for "{n}" (client must await a continuation); false for "{n+}". */
  readonly synchronizing: boolean;
}

export interface LiteralDefects {
  /** Report a synchronizing "{n}" as non-synchronizing. Violates R-9051-4.3-a. */
  readonly treatSyncAsNonSync?: boolean;
}

const NONE: LiteralInfo = { hasLiteral: false, octetCount: null, synchronizing: false };

/** Detect a trailing literal marker on `line` (with or without a trailing CRLF). */
export function detectLiteral(line: Buffer, defects: LiteralDefects = {}): LiteralInfo {
  const s = line.toString('latin1').replace(/\r?\n$/, '');
  const m = /\{(\d+)(\+?)\}$/.exec(s);
  if (m === null) return NONE;
  const octetCount = Number(m[1]);
  const nonSync = m[2] === '+';
  const synchronizing = nonSync ? false : defects.treatSyncAsNonSync !== true;
  return { hasLiteral: true, octetCount, synchronizing };
}
