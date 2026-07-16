/**
 * An SPF record parser and evaluator (RFC 7208 §4.5/§4.6), with switchable defects.
 *
 * Two pure functions: parse a "v=spf1 ..." record into version + ordered terms, and
 * evaluate those terms to a result given which mechanisms match. DNS resolution and
 * macro expansion are out of scope for this increment — the match decision is
 * injected — which keeps the load-bearing logic (the version gate, strict
 * left-to-right first-match, and qualifier semantics) testable without a network.
 *
 * The injected match function is how we test evaluation order deterministically: it
 * decides whether each non-"all" mechanism matches; "all" always matches, per spec.
 */

export type Qualifier = '+' | '-' | '~' | '?';
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror';

export interface SpfTerm {
  readonly qualifier: Qualifier;
  /** Mechanism or modifier name, lowercased (e.g. "a", "mx", "all", "redirect"). */
  readonly mechanism: string;
  /** The ":"/"/"-introduced argument (mechanism) or the "="-introduced value (modifier). */
  readonly value: string | null;
  readonly isModifier: boolean;
  readonly raw: string;
}

export interface SpfRecord {
  readonly valid: boolean;
  readonly version: string | null;
  readonly terms: readonly SpfTerm[];
  readonly anomalies: readonly string[];
}

export interface SpfParseDefects {
  /** Accept a version that is not exactly "v=spf1". Violates R-7208-4.5-a. */
  readonly acceptAnyVersion?: boolean;
  /** Default a qualifier-less mechanism to neutral ("?") instead of pass ("+"). Violates R-7208-4.6.2-b. */
  readonly defaultQualifierNeutral?: boolean;
}

export interface SpfEvalDefects {
  /** Evaluate right-to-left, so the last match wins instead of the first. Violates R-7208-4.6.2-a. */
  readonly lastMatchWins?: boolean;
}

const isQualifier = (c: string): c is Qualifier => c === '+' || c === '-' || c === '~' || c === '?';

export function parseSpfRecord(record: Buffer, defects: SpfParseDefects = {}): SpfRecord {
  const line = record.toString('latin1').trim();
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  const version = tokens[0] ?? null;
  const anomalies: string[] = [];
  let valid = true;

  // R-7208-4.5-a: the version must be exactly "v=spf1".
  if (version !== 'v=spf1' && defects.acceptAnyVersion !== true) {
    valid = false;
    anomalies.push('bad-version');
  }

  const terms: SpfTerm[] = [];
  for (const tok of tokens.slice(1)) {
    const first = tok[0] ?? '';
    let qualifier: Qualifier;
    let body: string;
    if (isQualifier(first)) {
      qualifier = first;
      body = tok.slice(1);
    } else {
      qualifier = defects.defaultQualifierNeutral === true ? '?' : '+';
      body = tok;
    }
    if (body.includes('=')) {
      const eq = body.indexOf('=');
      terms.push({ qualifier, mechanism: body.slice(0, eq).toLowerCase(), value: body.slice(eq + 1), isModifier: true, raw: tok });
    } else {
      const sep = body.search(/[:/]/);
      const name = (sep === -1 ? body : body.slice(0, sep)).toLowerCase();
      const value = sep === -1 ? null : body.slice(sep);
      terms.push({ qualifier, mechanism: name, value, isModifier: false, raw: tok });
    }
  }

  return { valid, version, terms, anomalies };
}

function qualifierToResult(q: Qualifier): SpfResult {
  switch (q) {
    case '+':
      return 'pass';
    case '-':
      return 'fail';
    case '~':
      return 'softfail';
    case '?':
      return 'neutral';
  }
}

/**
 * Evaluate a parsed record: the first mechanism (left to right) that matches returns
 * its qualifier's result. "all" always matches. `matches` decides every other
 * mechanism. An invalid (discarded) record yields "none"; no match yields "neutral".
 */
export function evaluateSpf(record: SpfRecord, matches: (term: SpfTerm) => boolean, defects: SpfEvalDefects = {}): SpfResult {
  if (!record.valid) return 'none';
  const ordered = defects.lastMatchWins === true ? [...record.terms].reverse() : record.terms;
  for (const t of ordered) {
    if (t.isModifier) continue;
    const matched = t.mechanism === 'all' ? true : matches(t);
    if (matched) return qualifierToResult(t.qualifier);
  }
  return 'neutral';
}
