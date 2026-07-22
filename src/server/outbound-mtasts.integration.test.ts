/**
 * MTA-STS enforcement on the outbound relay (RFC 8461). An ENFORCE policy must make the
 * relay (1) refuse to deliver to an MX that is not listed in the policy, (2) require
 * STARTTLS with a VALID certificate — never downgrading to plaintext and never accepting an
 * invalid cert — deferring (transient) instead of delivering when it can't. A testing/none
 * or absent policy must leave the opportunistic behavior untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayOutbound } from './outbound.ts';
import { SmtpReceiver, type DeliveredMessage } from './smtp-receiver.ts';
import { parseStsPolicy, type StsPolicy } from '../transport/mta-sts.ts';
import { StsCache, type StsResolverDeps } from './mta-sts-resolve.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const policyOf = (text: string): StsPolicy => parseStsPolicy(Buffer.from(text, 'latin1'));
const enforce = (mx: string): StsPolicy => policyOf(`version: STSv1\nmode: enforce\nmx: ${mx}\nmax_age: 86400\n`);

const MSG = { from: 'me@sender.test', recipients: ['friend@elsewhere.example'], data: Buffer.from('Subject: t\r\n\r\nhi\r\n', 'latin1') };

/** Relay MSG to a capture MX on 127.0.0.1:port, with an injected MTA-STS policy. */
async function relay(port: number, policy: StsPolicy | null) {
  return relayOutbound(MSG, {
    clientName: 'sender.test',
    resolveHosts: async () => ['127.0.0.1'],
    port,
    resolveStsPolicy: async () => policy,
  });
}

test('enforce + an MX that does not offer STARTTLS → not delivered, deferred (no downgrade)', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); },{ domain: 'mx.elsewhere.example' }); // plaintext
  try {
    const [r] = await relay(mx.port, enforce('127.0.0.1'));
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'transient', 'a policy failure defers, not bounces');
    assert.equal(received.length, 0, 'the message was NOT delivered in the clear');
  } finally {
    await mx.close();
  }
});

test('enforce + an MX with an untrusted (self-signed) certificate → not delivered', async () => {
  const received: DeliveredMessage[] = [];
  // Offers STARTTLS, but with the self-signed test cert — invalid under enforce.
  const mx = await SmtpReceiver.start((m) => { received.push(m); },{ domain: 'mx.elsewhere.example', tls: { key: TEST_KEY, cert: TEST_CERT } });
  try {
    const [r] = await relay(mx.port, enforce('127.0.0.1'));
    assert.equal(r!.ok, false);
    assert.equal(received.length, 0, 'an unvalidated certificate must not receive mail under enforce');
  } finally {
    await mx.close();
  }
});

test('enforce + no MX matches the policy → deferred without connecting', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); },{ domain: 'mx.elsewhere.example' });
  try {
    const [r] = await relay(mx.port, enforce('mail.someone-else.example')); // 127.0.0.1 not listed
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'transient');
    assert.match(r!.detail, /no MX matches the MTA-STS enforce policy/);
    assert.equal(received.length, 0);
  } finally {
    await mx.close();
  }
});

test('a testing-mode policy does NOT block delivery (opportunistic behavior preserved)', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); },{ domain: 'mx.elsewhere.example' }); // plaintext
  try {
    const [r] = await relay(mx.port, policyOf('version: STSv1\nmode: testing\nmx: mail.someone-else.example\nmax_age: 86400\n'));
    assert.equal(r!.ok, true, 'testing mode is report-only — it must not block mail');
    assert.equal(received.length, 1);
  } finally {
    await mx.close();
  }
});

test('no policy at all → delivered opportunistically, exactly as before MTA-STS', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); },{ domain: 'mx.elsewhere.example' });
  try {
    const [r] = await relay(mx.port, null);
    assert.equal(r!.ok, true);
    assert.equal(received.length, 1);
  } finally {
    await mx.close();
  }
});

test('a CACHED enforce policy under a DNS blackout still refuses a plaintext MX (§5.1 end-to-end)', async () => {
  // The downgrade the cache fix closes, end-to-end: prime an enforce policy, then black out the
  // (unauthenticated) TXT lookup - as an active attacker would to strip TLS. The cached policy
  // must keep enforcing, so a plaintext-only MX still receives NOTHING.
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); }, { domain: 'mx.elsewhere.example' }); // plaintext, no STARTTLS
  try {
    const cache = new StsCache();
    let txtWorks = true;
    const deps: StsResolverDeps = {
      resolveTxt: async () => { if (!txtWorks) throw new Error('SERVFAIL'); return ['v=STSv1; id=v1']; },
      fetchPolicy: async () => Buffer.from('version: STSv1\nmode: enforce\nmx: 127.0.0.1\nmax_age: 86400\n', 'latin1'),
      now: () => 1_000_000,
    };
    assert.equal((await cache.resolve('elsewhere.example', deps))?.mode, 'enforce', 'the policy primes the cache');
    txtWorks = false; // the DNS blackout begins
    const [r] = await relayOutbound(MSG, {
      clientName: 'sender.test',
      resolveHosts: async () => ['127.0.0.1'],
      port: mx.port,
      resolveStsPolicy: (d) => cache.resolve(d, deps),
    });
    assert.equal(r!.ok, false, 'enforce still applies from the cache - no plaintext delivery');
    assert.equal(r!.classification, 'transient', 'a policy failure defers, it does not bounce');
    assert.equal(received.length, 0, 'the plaintext MX received nothing despite the DNS blackout');
  } finally {
    await mx.close();
  }
});
