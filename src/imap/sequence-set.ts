/**
 * IMAP sequence-set parsing (RFC 9051 §9), with switchable defects.
 *
 * Resolves a message set like "1:5,7,10:*" into the concrete numbers it denotes,
 * given the largest number in use. Two rules with teeth: "*" is the largest number
 * (not a literal), and a range is order-independent ("12:10" == "10:12"). Used by
 * FETCH/STORE/COPY/SEARCH — a parser that gets either wrong addresses the wrong
 * messages.
 */

export interface SequenceSetDefects {
  /** Treat "*" as the literal 1. Violates R-9051-9-a. */
  readonly starIsLiteralOne?: boolean;
  /** Treat a high:low range as empty instead of normalising it. Violates R-9051-2.3.1.1-d. */
  readonly rangeNotCommutative?: boolean;
}

/**
 * Parse a sequence-set into a sorted, de-duplicated list of numbers within
 * [1, largest]. `largest` is the largest message number / UID in use.
 */
export function parseSequenceSet(set: string, largest: number, defects: SequenceSetDefects = {}): number[] {
  const result = new Set<number>();
  const resolve = (token: string): number => {
    if (token === '*') return defects.starIsLiteralOne === true ? 1 : largest;
    return Number(token);
  };

  for (const part of set.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      const n = resolve(trimmed);
      if (Number.isInteger(n) && n >= 1) result.add(n);
      continue;
    }
    const a = resolve(trimmed.slice(0, colon));
    const b = resolve(trimmed.slice(colon + 1));
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    // R-9051-2.3.1.1-d: ranges are order-independent.
    const [lo, hi] = defects.rangeNotCommutative === true ? [a, b] : [Math.min(a, b), Math.max(a, b)];
    for (let n = lo; n <= hi; n++) if (n >= 1) result.add(n);
  }
  return [...result].sort((x, y) => x - y);
}
