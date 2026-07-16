/**
 * SMTP SIZE-extension enforcement (RFC 1870), with switchable defects.
 *
 * Decides whether a message is within the server's size limit. Two rules: an
 * over-limit message is rejected 552, and the enforcement is against the ACTUAL
 * received size — the client's declared SIZE is only a pre-transmission hint and
 * MUST NOT be trusted for the real check.
 */

export interface SizeDecision {
  readonly accepted: boolean;
  /** 250 when accepted, 552 when the message exceeds the maximum. */
  readonly code: number;
}

export interface SizeDefects {
  /** Accept an over-limit message. Violates R-1870-6.1-a. */
  readonly ignoreSizeLimit?: boolean;
  /** Enforce against the declared SIZE instead of the actual bytes. Violates R-1870-6-a. */
  readonly trustDeclaredSize?: boolean;
}

/**
 * Enforce the size limit. `declaredSize` is the client's MAIL FROM SIZE= hint (or
 * null); `actualSize` is the bytes actually received; `maxSize` is the server limit.
 */
export function enforceSize(declaredSize: number | null, actualSize: number, maxSize: number, defects: SizeDefects = {}): SizeDecision {
  if (defects.ignoreSizeLimit === true) return { accepted: true, code: 250 };

  // Pre-transmission: a declaration already over the limit is rejected up front.
  if (declaredSize !== null && declaredSize > maxSize) return { accepted: false, code: 552 };

  // R-1870-6-a: enforce against the ACTUAL received size, not the declaration.
  const effective = defects.trustDeclaredSize === true && declaredSize !== null ? declaredSize : actualSize;
  if (effective > maxSize) return { accepted: false, code: 552 };

  return { accepted: true, code: 250 };
}
