/**
 * Outcome-model invariants.
 *
 * This file defends the property that stops the suite from lying: that a
 * declined SHOULD is not a failure, and that a MAY cannot fail at all. If these
 * regress, the suite starts producing false findings — and a tool that cries
 * wolf about a MAY gets ignored the first time it is right about a MUST.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, isFinding, explain, InvalidExpectationError } from './outcome.ts';
import type { Judgement, Result } from './outcome.ts';
import type { Level } from '../register/types.ts';

const ALL_LEVELS: Level[] = [
  'MUST', 'MUST NOT', 'SHOULD', 'SHOULD NOT', 'MAY', 'REQUIRED', 'RECOMMENDED',
];

test('a satisfied requirement is conformant at every level', () => {
  for (const level of ALL_LEVELS) {
    assert.equal(judge({ kind: 'satisfied' }, level), 'conformant', `level ${level}`);
  }
});

test('a violated MUST / MUST NOT / REQUIRED is non-conformant', () => {
  for (const level of ['MUST', 'MUST NOT', 'REQUIRED'] as Level[]) {
    assert.equal(judge({ kind: 'violated', detail: 'x' }, level), 'non-conformant', `level ${level}`);
  }
});

test('a declined SHOULD / SHOULD NOT / RECOMMENDED is latitude, never a failure', () => {
  // The single most important assertion in this file. 124 SHOULDs and 30 SHOULD
  // NOTs live in RFC 5321; treating any of them as failures would make the suite
  // wrong about more of the spec than it is right about.
  for (const level of ['SHOULD', 'SHOULD NOT', 'RECOMMENDED'] as Level[]) {
    const outcome = judge({ kind: 'violated', detail: 'x' }, level);
    assert.equal(outcome, 'permitted-latitude', `level ${level}`);
    assert.equal(isFinding(outcome), false);
  }
});

test('a MAY reported as violated throws — that is a test-authoring bug', () => {
  // Failing loudly at authoring time beats emitting a false finding at run time.
  assert.throws(
    () => judge({ kind: 'violated', detail: 'server did not clear the high bit' }, 'MAY'),
    InvalidExpectationError,
  );
});

test('the MAY throw explains what to do instead', () => {
  try {
    judge({ kind: 'violated', detail: 'nope' }, 'MAY');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof InvalidExpectationError);
    assert.match(e.message, /cannot be violated/);
    assert.match(e.message, /'observed'/);
  }
});

test("'observed' records a MAY branch as latitude", () => {
  assert.equal(judge({ kind: 'observed', branch: 'rejected' }, 'MAY'), 'permitted-latitude');
});

test("'observed' on a non-MAY throws — an obligation has a right answer", () => {
  for (const level of ['MUST', 'SHOULD', 'MUST NOT', 'REQUIRED'] as Level[]) {
    assert.throws(
      () => judge({ kind: 'observed', branch: 'x' }, level),
      InvalidExpectationError,
      `level ${level}`,
    );
  }
});

test('inconclusive stays inconclusive at every level', () => {
  // Never silently upgraded to conformant. "We could not tell" must not read as
  // "the server was fine" — that is how coverage gets overstated.
  for (const level of ALL_LEVELS) {
    assert.equal(
      judge({ kind: 'inconclusive', reason: 'no fixture' }, level),
      'inconclusive',
      `level ${level}`,
    );
  }
});

test('only non-conformant is a finding', () => {
  assert.equal(isFinding('non-conformant'), true);
  assert.equal(isFinding('conformant'), false);
  assert.equal(isFinding('permitted-latitude'), false);
  assert.equal(isFinding('inconclusive'), false);
});

test('every judgement kind is handled for every level', () => {
  // Exhaustiveness: a new Level or Judgement kind must not fall through to a
  // silent default. Anything unhandled should throw, not guess.
  const judgements: Judgement[] = [
    { kind: 'satisfied' },
    { kind: 'violated', detail: 'd' },
    { kind: 'observed', branch: 'b' },
    { kind: 'inconclusive', reason: 'r' },
  ];
  for (const level of ALL_LEVELS) {
    for (const j of judgements) {
      try {
        const out = judge(j, level);
        assert.ok(
          ['conformant', 'non-conformant', 'permitted-latitude', 'inconclusive'].includes(out),
        );
      } catch (e) {
        assert.ok(e instanceof InvalidExpectationError, `unexpected error for ${level}/${j.kind}`);
      }
    }
  }
});

test('explain renders the outcome, the expectation and the evidence', () => {
  const result: Result = {
    requirementId: 'R-5321-2.3.8-a',
    testId: 'bare-lf-not-honoured',
    level: 'MUST NOT',
    outcome: 'non-conformant',
    judgement: { kind: 'violated', detail: 'server replied 250 to a bare-LF-terminated command' },
    expected: 'no reply to a command not terminated by CRLF',
    evidence: {
      transcript: [],
      reply: {
        code: 250,
        lines: [],
        enhanced: null,
        raw: Buffer.from('250 ok\r\n'),
        anomalies: [],
        multiline: false,
      },
      anomalies: ['bare-lf-terminator'],
    },
    elapsedMs: 12,
  };
  const out = explain(result);
  assert.match(out, /NON-CONFORMANT\s+R-5321-2\.3\.8-a\s+\(MUST NOT\)/);
  assert.match(out, /expected: no reply to a command not terminated by CRLF/);
  assert.match(out, /observed: server replied 250/);
  assert.match(out, /anomalies: bare-lf-terminator/);
  assert.match(out, /32 35 30/, 'the raw reply bytes must be in the explanation');
});
