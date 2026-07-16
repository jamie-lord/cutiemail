/**
 * The shared negative-control harness.
 *
 * Every corpus module proves the same two things about each case: it is
 * CONFORMANT against a clean server, and NON-CONFORMANT against a server carrying
 * exactly the defect the case is meant to catch. This factors that loop out so a
 * module's test file is a single call, and so the discipline cannot be quietly
 * skipped — a module that does not call this has no negative-control coverage,
 * and its wire requirements show as `test-only` in the coverage report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { baselineFixture } from '../conformance/fixture.ts';
import type { Fixture } from '../conformance/fixture.ts';
import { withMutant, MutantServer } from '../testing/mutant-server.ts';
import type { Defects } from '../testing/mutant-server.ts';
import { SinkServer } from '../testing/sink-server.ts';
import type { TestCase, Mutant } from '../conformance/test-case.ts';

/** A fixture rich enough for any corpus case; harmless where unused. */
export const richFixture: Fixture = {
  ...baselineFixture('conformance-suite.invalid'),
  validRecipient: 'recipient@example.com',
  rejectedRecipient: 'nobody@example.com',
  nonRelayDomain: 'not-served.example.org',
  postmaster: 'postmaster@example.com',
  longLocalPartRecipient: `${'a'.repeat(64)}@example.com`, // 64-octet local-part (§4.5.3.1.1 floor)
  // ~251-octet domain, valid label lengths (<=63 each), near the §4.5.3.1.2 floor of 255.
  longDomainRecipient: `user@${'a'.repeat(60)}.${'a'.repeat(60)}.${'a'.repeat(60)}.${'a'.repeat(60)}.example`,
  declaredSizeLimit: 10_485_760,
  source: 'operator-declared',
};

const VALID_RECIPIENTS = ['recipient@example.com'];
// The mutant must reject the fixture's declared rejected recipient (550) so the
// delivery-path rejection cases have a conformant baseline to observe.
const REJECTED_RECIPIENTS = richFixture.rejectedRecipient ? [richFixture.rejectedRecipient] : [];

function defectFor(name: string): Defects {
  return { [name]: true } as Defects;
}

/**
 * Register the standard negative-control tests for a corpus module.
 *
 * For each mutant: the caught case must not be a finding against a clean server,
 * and must be a finding against the defect. Also asserts every case in the module
 * has a mutant — a wire case without one is only half a test.
 */
export function verifyNegativeControls(
  moduleName: string,
  cases: readonly TestCase[],
  mutants: readonly Mutant[],
): void {
  const byId = new Map(cases.map((c) => [c.id, c]));

  for (const mutant of mutants) {
    const tc = byId.get(mutant.catches);

    test(`${moduleName}: ${mutant.catches} — clean server is not a finding`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      await withMutant({ validRecipients: VALID_RECIPIENTS, rejectedRecipients: REJECTED_RECIPIENTS }, async (port) => {
        const result = await runCase(tc, {
          connect: { host: '127.0.0.1', port },
          fixture: richFixture,
        });
        assert.notEqual(
          result.outcome,
          'non-conformant',
          `clean server flagged as a finding: ` +
            `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
        );
        assert.ok(
          result.outcome === 'conformant' || result.outcome === 'inconclusive',
          `expected conformant/inconclusive on clean server, got ${result.outcome}`,
        );
      });
    });

    test(`${moduleName}: ${mutant.catches} — catches defect "${mutant.defect}"`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      await withMutant(
        { defects: defectFor(mutant.defect), validRecipients: VALID_RECIPIENTS, rejectedRecipients: REJECTED_RECIPIENTS },
        async (port) => {
          const result = await runCase(tc, {
            connect: { host: '127.0.0.1', port },
            fixture: richFixture,
          });
          assert.equal(
            result.outcome,
            'non-conformant',
            `defect ${mutant.defect} not caught by ${mutant.catches}: got ${result.outcome} ` +
              `(${result.judgement.kind === 'inconclusive' ? result.judgement.reason : ''})`,
          );
        },
      );
    });
  }

  test(`${moduleName}: every case has a negative control`, () => {
    const caught = new Set(mutants.map((m) => m.catches));
    for (const c of cases) {
      assert.ok(caught.has(c.id), `case ${c.id} has no mutant — it is only half a test`);
    }
  });
}

/**
 * The negative-control harness for SINK-based cases — the delivery/transparency
 * surface (dot-un-stuffing §4.5.2, case preservation §2.4-c/-d) that is invisible
 * from the client side. Same contract as verifyNegativeControls, but the run is
 * provisioned with a receiving sink and the mutant is told to RELAY to it, so the
 * case can read back what was delivered. Clean relay -> not a finding; the defect
 * corrupts the delivered message and the case catches it.
 */
export function verifySinkControls(
  moduleName: string,
  cases: readonly TestCase[],
  mutants: readonly Mutant[],
): void {
  const byId = new Map(cases.map((c) => [c.id, c]));

  const runWithSink = async (tc: TestCase, defects: Defects): Promise<import('../conformance/outcome.ts').Result> => {
    const sink = await SinkServer.start();
    const mutant = await MutantServer.start({
      defects,
      relayTo: sink.port,
      validRecipients: VALID_RECIPIENTS,
      rejectedRecipients: REJECTED_RECIPIENTS,
    });
    try {
      return await runCase(tc, { connect: { host: '127.0.0.1', port: mutant.port }, fixture: richFixture, sink });
    } finally {
      await mutant.close();
      await sink.close();
    }
  };

  for (const mutant of mutants) {
    const tc = byId.get(mutant.catches);

    test(`${moduleName}: ${mutant.catches} — clean relay is not a finding`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      const result = await runWithSink(tc, {});
      assert.notEqual(
        result.outcome,
        'non-conformant',
        `clean relay flagged as a finding: ${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
      );
      assert.ok(
        result.outcome === 'conformant' || result.outcome === 'inconclusive',
        `expected conformant/inconclusive on a clean relay, got ${result.outcome}`,
      );
    });

    test(`${moduleName}: ${mutant.catches} — catches defect "${mutant.defect}"`, async () => {
      assert.ok(tc !== undefined, `mutant catches unknown case ${mutant.catches}`);
      const result = await runWithSink(tc, defectFor(mutant.defect));
      assert.equal(
        result.outcome,
        'non-conformant',
        `defect ${mutant.defect} not caught by ${mutant.catches}: got ${result.outcome} ` +
          `(${result.judgement.kind === 'inconclusive' ? result.judgement.reason : ''})`,
      );
    });
  }

  test(`${moduleName}: every sink case has a negative control`, () => {
    const caught = new Set(mutants.map((m) => m.catches));
    for (const c of cases) {
      assert.ok(caught.has(c.id), `case ${c.id} has no mutant — it is only half a test`);
    }
  });
}
