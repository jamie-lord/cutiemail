/**
 * CRLF-discipline corpus: negative-control verification, plus a regression guard.
 *
 * Beyond the standard clean-vs-defect proofs, this module carries an extra
 * assertion that a HARDENED server — one that rejects a bare LF with a 500, the
 * Postfix smtpd_forbid_bare_newline behaviour — is reported CONFORMANT, not
 * failed. That is the exact false positive this guards against: treating any
 * reply to a bare LF as "the server acted on it" would have failed precisely
 * the smuggling-safe servers the suite exists to bless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from '../conformance/runner.ts';
import { withMutant } from '../testing/mutant-server.ts';
import { verifyNegativeControls, richFixture } from './negative-control.ts';
import { CASES, MUTANTS } from './crlf-discipline.ts';

verifyNegativeControls('crlf-discipline', CASES, MUTANTS);

const BARE_LF_CASES = ['bare-lf-command-not-honoured', 'bare-lf-line-acceptance-rejected'];

for (const id of BARE_LF_CASES) {
  test(`crlf-discipline: ${id} — a hardened server that REJECTS bare LF is conformant`, async () => {
    const tc = CASES.find((c) => c.id === id);
    assert.ok(tc !== undefined);
    // rejectBareLf models Postfix with smtpd_forbid_bare_newline: it answers a
    // bare-LF command with "500 bare <LF> received". That is a REFUSAL, not
    // acceptance, so it MUST NOT be a finding.
    await withMutant(
      { defects: { rejectBareLf: true }, validRecipients: ['recipient@example.com'] },
      async (port) => {
        const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture: richFixture });
        assert.equal(
          result.outcome,
          'conformant',
          `a server rejecting bare LF must be conformant, got ${result.outcome}: ` +
            `${result.judgement.kind === 'violated' ? result.judgement.detail : ''}`,
        );
      },
    );
  });
}
