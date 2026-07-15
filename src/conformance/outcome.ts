/**
 * What a conformance result actually is.
 *
 * The temptation is pass/fail. Pass/fail would make this suite lie, because most
 * of RFC 5321 is not MUST. Of the ~419 normative keyword instances in the
 * document, 124 are SHOULD, 30 SHOULD NOT and 62 MAY. A server that declines a
 * SHOULD is *conformant*; a tool that reds it has produced a false positive and
 * spent its credibility. A server exercising a MAY cannot be failed at all —
 * there is nothing to fail.
 *
 * So the model separates two questions that pass/fail conflates:
 *
 *   1. What did the server do?           -> Judgement (from the expectation)
 *   2. What does the spec make of that?  -> Outcome   (from Judgement + Level)
 *
 * The requirement's RFC 2119 level does real work here rather than sitting in
 * the register as documentation. `violated` + MUST is a finding; `violated` +
 * SHOULD is latitude worth recording; `violated` + MAY is a bug **in our test**,
 * and we throw rather than report it, because a MAY has no violation state and
 * writing an expectation that claims otherwise means the test author misread the
 * spec.
 *
 * `observed` exists for the MAY case done properly: RFC 5321 §2.4 says a server
 * "MAY clear the high-order bit or reject the message as invalid". Neither
 * branch is wrong. But which branch a server takes is a real interop hazard and
 * belongs in the matrix, so we record it rather than shrugging.
 */

import type { Level } from '../register/types.ts';
import type { WireEvent } from '../wire/transport.ts';
import type { Reply } from '../wire/reply.ts';
import { dump } from '../wire/bytes.ts';

/**
 * What the expectation concluded about the server's behaviour, before the spec
 * has an opinion about it.
 */
export type Judgement =
  /** The behaviour the requirement describes was observed. */
  | { readonly kind: 'satisfied'; readonly detail?: string }
  /** The requirement's behaviour was NOT observed. Severity is not decided here. */
  | { readonly kind: 'violated'; readonly detail: string }
  /** A permitted choice was taken; record which. Only valid for MAY. */
  | { readonly kind: 'observed'; readonly branch: string }
  /** We could not tell. A missing fixture, an unusable connection, a flake. */
  | { readonly kind: 'inconclusive'; readonly reason: string };

/**
 * The four states a conformance result may take.
 *
 * Deliberately not an enum — `erasableSyntaxOnly` forbids them, and a string
 * union serialises into the report without a mapping table anyway.
 */
export type Outcome =
  /** The server did what the requirement says. */
  | 'conformant'
  /** The server broke a MUST / MUST NOT / REQUIRED. A finding. */
  | 'non-conformant'
  /** Permitted by the spec: a declined SHOULD, or a MAY branch taken. Never a failure. */
  | 'permitted-latitude'
  /** Undetermined. Not evidence of anything — see `reason`. */
  | 'inconclusive';

export class InvalidExpectationError extends Error {}

const STRICT: readonly Level[] = ['MUST', 'MUST NOT', 'REQUIRED'];
const ADVISORY: readonly Level[] = ['SHOULD', 'SHOULD NOT', 'RECOMMENDED'];

/**
 * Map (judgement, level) -> outcome. The heart of the model.
 *
 * Throws when a MAY is reported as violated, because that combination cannot
 * arise from a correct test. Failing loudly at authoring time beats emitting a
 * false finding at run time — a suite that cries wolf about a MAY will be
 * ignored the first time it is right about a MUST.
 */
export function judge(judgement: Judgement, level: Level): Outcome {
  switch (judgement.kind) {
    case 'satisfied':
      return 'conformant';

    case 'inconclusive':
      return 'inconclusive';

    case 'observed':
      if (level !== 'MAY') {
        throw new InvalidExpectationError(
          `'observed' is only meaningful for a MAY; this requirement is ${level}. ` +
            `Use 'satisfied' or 'violated' — an ${level} has a right answer.`,
        );
      }
      return 'permitted-latitude';

    case 'violated':
      if (level === 'MAY') {
        throw new InvalidExpectationError(
          `a MAY cannot be violated — the spec permits both branches. ` +
            `Report 'observed' with which branch was taken. Detail was: ${judgement.detail}`,
        );
      }
      if (STRICT.includes(level)) return 'non-conformant';
      if (ADVISORY.includes(level)) return 'permitted-latitude';
      throw new InvalidExpectationError(`unhandled level: ${String(level)}`);
  }
}

/** True for outcomes that should turn a run red. Only one does. */
export function isFinding(outcome: Outcome): boolean {
  return outcome === 'non-conformant';
}

/**
 * Everything needed to triage a result without re-running it.
 *
 * Evidence is not optional. Calibration against Postfix and Exim (task #23)
 * assumes we are wrong until proven otherwise, and that triage is impossible
 * without the exact bytes. A result that says "non-conformant" and cannot show
 * the transcript is an accusation without evidence.
 */
export interface Evidence {
  readonly transcript: readonly WireEvent[];
  readonly reply: Reply | null;
  /** Anomalies the reply reader noticed, independent of what was expected. */
  readonly anomalies: readonly string[];
}

export interface Result {
  readonly requirementId: string;
  readonly testId: string;
  readonly level: Level;
  readonly outcome: Outcome;
  readonly judgement: Judgement;
  /** What the expectation was looking for, in words, for the report. */
  readonly expected: string;
  readonly evidence: Evidence;
  readonly elapsedMs: number;
}

/** Render a result for a human triaging it. */
export function explain(result: Result): string {
  const lines: string[] = [
    `${result.outcome.toUpperCase()}  ${result.requirementId}  (${result.level})`,
    `  test:     ${result.testId}`,
    `  expected: ${result.expected}`,
  ];
  switch (result.judgement.kind) {
    case 'violated':
      lines.push(`  observed: ${result.judgement.detail}`);
      break;
    case 'observed':
      lines.push(`  branch:   ${result.judgement.branch}`);
      break;
    case 'inconclusive':
      lines.push(`  reason:   ${result.judgement.reason}`);
      break;
    case 'satisfied':
      if (result.judgement.detail !== undefined) lines.push(`  observed: ${result.judgement.detail}`);
      break;
  }
  if (result.evidence.anomalies.length > 0) {
    lines.push(`  anomalies: ${result.evidence.anomalies.join('; ')}`);
  }
  if (result.evidence.reply !== null) {
    lines.push(dump(result.evidence.reply.raw, '  reply bytes:').replace(/^/gm, '  '));
  }
  return lines.join('\n');
}
