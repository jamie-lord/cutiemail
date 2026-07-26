/**
 * The conformance suite, run against this project's own inbound listener.
 *
 * The suite was built and calibrated against Postfix, and for a long time it was never pointed at
 * the server in the same repository — which is how a MUST-level gap survived: `RCPT TO:<postmaster>`
 * with no domain (RFC 5321 §2.3.5, §4.5.1) was refused, and nothing here would ever have said so.
 * Shipping a conformance suite and not running it against your own server is the software equivalent
 * of writing the exam and not sitting it.
 *
 * This is the sitting. A real daemon on ephemeral loopback ports, the whole corpus over a real
 * socket, and zero findings required.
 *
 * Inconclusive is not failure — a case whose fixture this deployment cannot provide verified
 * nothing and accuses nothing — but a run that is ENTIRELY inconclusive verified nothing at all,
 * which is a false green rather than a pass, so that is failed too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { runSuite } from '../conformance/runner.ts';
import { connectOptions } from '../conformance/config.ts';
import { withPostmasterConvention, type Fixture } from '../conformance/fixture.ts';
import { ALL_CASES } from '../corpus/index.ts';
import { explain, isFinding } from '../conformance/outcome.ts';

const DOMAIN = 'conformance.one.example';

test('the corpus finds nothing against our own inbound listener', { timeout: 180_000 }, async () => {
  const server = await startServer({
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: DOMAIN,
    accounts: [{ user: 'you', pass: 'a-real-passphrase' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // No live DNS: inbound auth checks must not reach the network from a test.
    dkimKeyResolver: async () => null,
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
    outboundMode: 'hold',
  });

  try {
    const fixture: Fixture = withPostmasterConvention(
      {
        clientDomain: 'suite.one.example',
        validRecipient: `you@${DOMAIN}`,
        // We refuse an unknown local user synchronously with 550 5.1.1, which is exactly the
        // contract this fixture field asserts (no deferred verification here).
        rejectedRecipient: `definitely-nobody@${DOMAIN}`,
        // The inbound port relays for nothing: every foreign domain is refused.
        nonRelayDomain: 'two.example',
        source: 'operator-declared',
      },
      DOMAIN,
    );

    const results = await runSuite(ALL_CASES, {
      connect: connectOptions({ name: 'cutiemail', serverDomain: DOMAIN, host: '127.0.0.1', port: server.inbound.port, tls: 'none', fixture }),
      fixture,
    });

    const findings = results.filter((r) => isFinding(r.outcome));
    assert.deepEqual(
      findings.map((f) => f.testId),
      [],
      `the corpus must pass against our own server:\n\n${findings.map(explain).join('\n\n')}`,
    );

    // A run where nothing was conclusive proves nothing, and would go green forever.
    const conclusive = results.filter((r) => r.outcome !== 'inconclusive');
    assert.ok(conclusive.length > results.length / 2, `only ${conclusive.length} of ${results.length} cases were conclusive`);
  } finally {
    await server.close();
  }
});
