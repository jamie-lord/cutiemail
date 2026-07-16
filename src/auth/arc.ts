/**
 * ARC chain-structure validation (RFC 8617 §5.2), with switchable defects.
 *
 * Validates the STRUCTURE of an Authenticated Received Chain before any signature
 * crypto: each hop's ARC Set is complete, the instances form a continuous 1..N
 * sequence, and the seal "cv" values are consistent (i=1 none, i>1 pass, never
 * fail). The AMS/AS signature verification (which reuses the DKIM machinery over
 * ARC-specific canonicalization) is a later increment.
 */

export type ChainValidation = 'none' | 'pass' | 'fail';

export interface ArcSet {
  readonly instance: number;
  /** The ARC-Seal "cv" value. */
  readonly cv: ChainValidation;
  readonly hasAAR: boolean; // ARC-Authentication-Results
  readonly hasAMS: boolean; // ARC-Message-Signature
  readonly hasAS: boolean; // ARC-Seal
}

export interface ArcDefects {
  /** Tolerate gaps/repetition in the instance sequence. Violates R-8617-5.2-a. */
  readonly acceptGaps?: boolean;
  /** Tolerate a wrong or "fail" cv value. Violates R-8617-5.2-b. */
  readonly acceptWrongCv?: boolean;
}

export interface ArcResult {
  /** The Chain Validation Status: "none" (no chain), "pass" (structure valid), or "fail". */
  readonly status: ChainValidation;
  readonly anomalies: readonly string[];
}

export function validateArcChainStructure(sets: readonly ArcSet[], defects: ArcDefects = {}): ArcResult {
  if (sets.length === 0) return { status: 'none', anomalies: [] };

  const anomalies: string[] = [];
  let failed = false;

  // A: each set complete (exactly one AAR, AMS, AS).
  for (const s of sets) {
    if (!s.hasAAR || !s.hasAMS || !s.hasAS) {
      anomalies.push(`incomplete-set:${s.instance}`);
      failed = true;
    }
  }

  // B: instances form a continuous 1..N sequence.
  const instances = [...sets.map((s) => s.instance)].sort((a, b) => a - b);
  const continuous = instances.every((n, i) => n === i + 1);
  if (!continuous) {
    anomalies.push('non-continuous-instances');
    if (defects.acceptGaps !== true) failed = true;
  }

  // C: cv values — i=1 is "none", i>1 is "pass", never "fail".
  for (const s of sets) {
    const expected: ChainValidation = s.instance === 1 ? 'none' : 'pass';
    if (s.cv === 'fail') {
      anomalies.push(`cv-fail:${s.instance}`);
      if (defects.acceptWrongCv !== true) failed = true;
    } else if (s.cv !== expected) {
      anomalies.push(`cv-mismatch:${s.instance}:${s.cv}`);
      if (defects.acceptWrongCv !== true) failed = true;
    }
  }

  return { status: failed ? 'fail' : 'pass', anomalies };
}
