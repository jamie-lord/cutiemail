/**
 * RFC 5322 §3.6 field validation, with switchable defects.
 *
 * Parsing (parse.ts) finds structure; validation applies the occurrence rules a
 * conformant message must satisfy — the required fields (Date, From) and the
 * singleton fields (at most one each). Kept separate from the parser because a
 * server both PARSES inbound mail (where it must detect these violations to decide
 * accept/reject) and GENERATES outbound mail (where it must not produce them).
 *
 * Defects mirror the mutant pattern: each turns off one check, so the corpus can
 * prove it detects the violation.
 */

import type { Message } from './model.ts';

/** Fields the RFC 5322 §3.6 table caps at Max=1. Everything else may repeat. */
const SINGLETON: ReadonlySet<string> = new Set([
  'date',
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'message-id',
  'in-reply-to',
  'references',
  'subject',
]);

export interface FieldViolation {
  readonly kind: 'missing-date' | 'missing-from' | 'duplicate-singleton';
  /** For duplicate-singleton: the lower-cased field name. */
  readonly field?: string;
}

export interface ValidatorDefects {
  /** Do not flag a missing Date or From. Violates detection of R-5322-3.6-a. */
  readonly skipRequiredCheck?: boolean;
  /** Do not flag a repeated singleton field. Violates detection of R-5322-3.6-b. */
  readonly allowDuplicateSingletons?: boolean;
}

function fieldCounts(msg: Message): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of msg.headers) {
    const name = h.name.toString('latin1').trim().toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function validateFields(msg: Message, defects: ValidatorDefects = {}): FieldViolation[] {
  const counts = fieldCounts(msg);
  const violations: FieldViolation[] = [];

  if (!defects.skipRequiredCheck) {
    if ((counts.get('date') ?? 0) === 0) violations.push({ kind: 'missing-date' });
    if ((counts.get('from') ?? 0) === 0) violations.push({ kind: 'missing-from' });
  }

  if (!defects.allowDuplicateSingletons) {
    for (const [name, count] of counts) {
      if (count > 1 && SINGLETON.has(name)) {
        violations.push({ kind: 'duplicate-singleton', field: name });
      }
    }
  }

  return violations;
}

/** Convenience for corpus assertions. */
export function hasViolation(vs: readonly FieldViolation[], kind: FieldViolation['kind'], field?: string): boolean {
  return vs.some((v) => v.kind === kind && (field === undefined || v.field === field));
}
