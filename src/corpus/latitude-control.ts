/**
 * The latitude-observation harness — the SHOULD/MAY counterpart to
 * verifyNegativeControls.
 *
 * A SHOULD/MAY requirement has NO violation state, so it cannot have a
 * "catches a violation" negative control. What it CAN be proven to do is
 * classify correctly in both directions:
 *
 *   - against a server that FOLLOWS the SHOULD  -> conformant
 *   - against a server that DECLINES the SHOULD -> permitted-latitude (NOT a
 *     finding — declining a SHOULD is never a failure)
 *
 * Proving the second half is the whole point: it is where the four-state model
 * earns its keep, and where a lazy pass/fail suite would wrongly red a
 * conformant server. So a LatitudeControl pairs a case with a "follows" mutant
 * config and a "declines" one, and this harness asserts the two outcomes.
 *
 * These cases enrich the per-server MATRIX (which SHOULD each server honours) —
 * differential behavioural data — without ever producing a false finding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import type { Defects } from '../testing/mutant-server.ts';
import type { TestCase } from '../conformance/test-case.ts';
import { richFixture } from './negative-control.ts';
import { requirement } from '../register/rfc5321.ts';

const VALID_RECIPIENTS = ['recipient@example.com'];

export interface LatitudeControl {
  /** The case id this control exercises. */
  readonly case: string;
  /** Mutant defects that make the server FOLLOW the SHOULD (→ conformant). */
  readonly follows: Defects;
  /** Mutant defects that make the server DECLINE it (→ permitted-latitude). */
  readonly declines: Defects;
}

export function verifyLatitudeControls(
  moduleName: string,
  cases: readonly TestCase[],
  controls: readonly LatitudeControl[],
): void {
  const byId = new Map(cases.map((c) => [c.id, c]));

  for (const ctrl of controls) {
    const tc = byId.get(ctrl.case);

    test(`${moduleName}: ${ctrl.case} — a server that FOLLOWS the SHOULD is conformant`, async () => {
      assert.ok(tc !== undefined, `no case ${ctrl.case}`);
      await withMutant({ defects: ctrl.follows, validRecipients: VALID_RECIPIENTS }, async (port) => {
        const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture: richFixture });
        assert.equal(
          result.outcome,
          'conformant',
          `a server following the SHOULD should be conformant, got ${result.outcome}`,
        );
      });
    });

    test(`${moduleName}: ${ctrl.case} — a server that DECLINES the SHOULD is permitted-latitude, not a finding`, async () => {
      assert.ok(tc !== undefined, `no case ${ctrl.case}`);
      await withMutant({ defects: ctrl.declines, validRecipients: VALID_RECIPIENTS }, async (port) => {
        const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture: richFixture });
        assert.equal(
          result.outcome,
          'permitted-latitude',
          `declining a SHOULD must be permitted-latitude, not ${result.outcome} ` +
            `(a pass/fail suite would wrongly red this conformant server)`,
        );
      });
    });
  }

  test(`${moduleName}: every case has a latitude control`, () => {
    const covered = new Set(controls.map((c) => c.case));
    for (const c of cases) {
      assert.ok(covered.has(c.id), `latitude case ${c.id} has no control`);
    }
  });

  test(`${moduleName}: latitude cases cite a SHOULD/MAY, never a MUST`, () => {
    // The load-bearing guard: a latitude-controlled case is credited as
    // fully-covered WITHOUT a violation-catching mutant. That is sound only for
    // SHOULD/MAY (which have no violation state). A MUST case sneaking in here
    // would be marked covered with no negative control — a real hole. Forbid it.
    for (const c of cases) {
      const level = requirement(c.requirement).level;
      assert.ok(
        level === 'SHOULD' || level === 'SHOULD NOT' || level === 'MAY' || level === 'RECOMMENDED',
        `latitude case ${c.id} cites ${c.requirement} (${level}); latitude is only for SHOULD/MAY — a MUST needs a negative-control mutant`,
      );
    }
  });
}
