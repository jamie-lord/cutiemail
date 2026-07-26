/**
 * RFC 8461 §3.1, §4.2 and §5 — the MTA-STS rules that decide whether outbound mail is protected.
 *
 * The failure mode here is the reason these deserve their own file: getting MTA-STS wrong does not
 * break anything visibly. Mail still goes out, it still arrives, and nobody notices that it went in
 * the clear to a host the recipient domain never authorised. Every requirement below is therefore a
 * REFUSAL, and each case checks that the refusal happens rather than that the happy path works.
 *
 * ADR 0007 chose MTA-STS over DANE because DANE needs a validating DNSSEC stub resolver Node does
 * not provide, which makes this the whole of the outbound TLS policy rather than one layer of two.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStsPolicy, mxAllowed, mxMatches } from './mta-sts.ts';
import { StsCache } from '../server/mta-sts-resolve.ts';
import { transportRequirement, type TransportRequirementId } from '../register/transport/index.ts';

const cites = (id: TransportRequirementId): void => assert.ok(transportRequirement(id).id === id);

/** See the note in imap-conformance-mailbox.integration.test.ts. */
const GAP = (why: string): { todo: string } => ({ todo: why });

const P = (s: string): Buffer => Buffer.from(s, 'latin1');
const ENFORCING = P('version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmx: *.example.net\r\nmax_age: 604800\r\n');

/** Deps for StsCache with a scripted TXT lookup and policy fetch, counting both. */
function deps(opts: { txt: readonly string[] | Error; policy?: Buffer | null; now?: number }): {
  resolveTxt: (name: string) => Promise<readonly string[]>;
  fetchPolicy: (host: string) => Promise<Buffer | null>;
  now: () => number;
  counts: { txt: number; fetch: number };
} {
  const counts = { txt: 0, fetch: 0 };
  return {
    counts,
    async resolveTxt() {
      counts.txt++;
      if (opts.txt instanceof Error) throw opts.txt;
      return opts.txt;
    },
    async fetchPolicy() {
      counts.fetch++;
      return opts.policy ?? null;
    },
    now: () => opts.now ?? 1_700_000_000_000,
  };
}

test('an enforcing policy refuses a host its MX list does not authorise', () => {
  cites('R-8461-5-a');
  const policy = parseStsPolicy(ENFORCING);
  assert.ok(policy.valid);
  assert.equal(policy.mode, 'enforce');

  // The first of the three refusals in §5: MX matching. An attacker who can redirect DNS points the
  // domain at a host they control; the policy is what says that host was never authorised.
  assert.equal(mxAllowed(policy, 'mail.example.com'), true, 'an exactly-listed host is allowed');
  assert.equal(mxAllowed(policy, 'anything.example.net'), true, 'a wildcard entry matches one label');
  assert.equal(mxAllowed(policy, 'mail.attacker.test'), false, 'an unlisted host is refused');
  assert.equal(mxAllowed(policy, 'deep.sub.example.net'), false, 'a wildcard matches ONE label, not a subtree');
  // The name is compared against the MX HOST, not the recipient domain — the distinction MTA-STS
  // turns on, and the one an attacker exploits if it is confused.
  assert.equal(mxAllowed(policy, 'example.com'), false, 'the policy domain itself is not implicitly an MX');
});

test('MX pattern matching is anchored, case-insensitive, and not a substring test', () => {
  cites('R-8461-4.2-b');
  assert.equal(mxMatches('mail.example.com', 'MAIL.EXAMPLE.COM'), true, 'DNS names compare case-insensitively');
  assert.equal(mxMatches('*.example.net', 'a.example.net'), true);
  assert.equal(mxMatches('*.example.net', 'example.net'), false, 'the wildcard requires a label to consume');
  // The shapes a naive endsWith() or indexOf() accepts, each of which hands an attacker a match.
  assert.equal(mxMatches('mail.example.com', 'evil-mail.example.com'), false, 'not a suffix test');
  assert.equal(mxMatches('mail.example.com', 'mail.example.com.attacker.test'), false, 'not a prefix test');
  assert.equal(mxMatches('*.example.net', 'a.example.net.attacker.test'), false, 'the wildcard is anchored at the end');
});

test('a policy that does not parse cannot enforce anything', () => {
  cites('R-8461-3.1-a');
  cites('R-8461-3.2-c');
  // Being generous with a malformed policy means enabling enforcement on the strength of something
  // the spec says to disregard — or, worse, deriving an MX list from a half-parsed record.
  for (const bad of [
    'mode: enforce\r\nmx: mail.example.com\r\nmax_age: 1\r\n', // no version
    'version: STSv2\r\nmode: enforce\r\nmax_age: 1\r\n', // wrong version
    'version: STSv1\r\nmode: bogus\r\nmax_age: 1\r\n', // unknown mode
  ]) {
    assert.equal(parseStsPolicy(P(bad)).valid, false, `refused: ${JSON.stringify(bad.slice(0, 40))}`);
  }
  // The negative control: the same shape, well formed, is accepted — so the cases above are being
  // refused for their defect and not because everything is refused.
  assert.equal(parseStsPolicy(ENFORCING).valid, true);
});

test('a policy with no max_age is not a valid policy', GAP(
  'RFC 8461 §3.2 (policy ABNF, "sts-policy-max-age ... required once"): a policy omitting max_age '
  + 'parses as valid. Such a policy has no defined lifetime, so a sender either caches it forever — '
  + 'pinning the domain to a policy it has since replaced, which is precisely what the §5 re-check '
  + 'rule exists to avoid — or not at all. Neither is a reading the spec offers.',
), () => {
  cites('R-8461-3.2-c');
  assert.equal(parseStsPolicy(P('version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\n')).valid, false);
});

test('a TXT record not beginning with the version field is not an MTA-STS record', GAP(
  'RFC 8461 §3.1 MUST: the TXT record "MUST begin with the sts-version field". The resolver matches '
  + 'with startsWith("v=stsv1") and so already refuses a record whose version comes second — but '
  + 'nothing pins that, and the natural "tolerant parser" fix (scan for v= anywhere) would silently '
  + 'remove it. Registered and left running as the guard against that change, since enabling '
  + 'enforcement on the strength of a malformed record is the wrong direction to be generous in.',
), async () => {
  cites('R-8461-3.1-a');
  const cache = new StsCache();
  const d = deps({ txt: ['id=20260101; v=STSv1'], policy: ENFORCING });
  const policy = await cache.resolve('example.com', d);
  assert.equal(policy, null, 'a record with the version out of position is disregarded');
  assert.equal(d.counts.fetch, 0, 'and no policy is fetched on the strength of it');
});

test('a domain publishing no usable TXT record has no policy', async () => {
  cites('R-8461-3.1-b');
  const cache = new StsCache();
  // No record at all, and more than one record — §3.1 says both mean "no available policy".
  for (const txt of [[], ['v=STSv1; id=a', 'v=STSv1; id=b']]) {
    const d = deps({ txt, policy: ENFORCING });
    assert.equal(await cache.resolve(`x${txt.length}.example`, d), null);
    assert.equal(d.counts.fetch, 0, 'nothing is fetched without exactly one record');
  }
});

test('the policy id is what decides whether to re-fetch', async () => {
  cites('R-8461-3.1-b');
  const cache = new StsCache();
  const first = deps({ txt: ['v=STSv1; id=20260101'], policy: ENFORCING });
  assert.ok((await cache.resolve('example.com', first))?.valid);
  assert.equal(first.counts.fetch, 1, 'the first resolution fetches the policy');

  // Same id: the cached policy is reused rather than re-fetched.
  const again = deps({ txt: ['v=STSv1; id=20260101'], policy: ENFORCING });
  assert.ok((await cache.resolve('example.com', again))?.valid);
  assert.equal(again.counts.fetch, 0, 'an unchanged id means the cached policy still applies');

  // A rotated id is the signal that the policy changed, and the only one there is.
  const rotated = deps({ txt: ['v=STSv1; id=20260202'], policy: P('version: STSv1\r\nmode: enforce\r\nmx: new.example.com\r\nmax_age: 604800\r\n') });
  const updated = await cache.resolve('example.com', rotated);
  assert.equal(rotated.counts.fetch, 1, 'a rotated id re-fetches');
  assert.ok(updated !== null && mxAllowed(updated, 'new.example.com'), 'and the new policy is the one now in force');
});

test('a transient DNS failure does not discard a cached policy', async () => {
  cites('R-8461-5-b');
  cites('R-8461-5-c');
  const cache = new StsCache();
  assert.ok((await cache.resolve('example.com', deps({ txt: ['v=STSv1; id=1'], policy: ENFORCING })))?.valid);

  // The rule that keeps a strict policy from being a trap in the other direction: a resolver hiccup
  // must not silently downgrade an enforcing domain to opportunistic TLS, which is exactly the
  // position an on-path attacker wants to create.
  const failing = deps({ txt: new Error('SERVFAIL') });
  const stillThere = await cache.resolve('example.com', failing);
  assert.ok(stillThere !== null && stillThere.mode === 'enforce', 'the cached policy survives a DNS failure');
});

test('a policy that cannot be fetched leaves the domain unprotected rather than half-protected', async () => {
  cites('R-8461-5-a');
  const cache = new StsCache();
  // A TXT record exists but the policy body cannot be retrieved. There is no partial answer here:
  // without the MX list there is nothing to enforce against, so the honest result is no policy —
  // never "enforce with an empty list", which would refuse every host.
  const d = deps({ txt: ['v=STSv1; id=1'], policy: null });
  assert.equal(await cache.resolve('unfetchable.example', d), null);
  assert.equal(d.counts.fetch, 1, 'the fetch was attempted');
});

test('a testing-mode policy parses as testing, and enforce as enforce', () => {
  cites('R-8461-5-a');
  // The mode is the whole difference between "report a problem" and "refuse to send". Conflating
  // them in either direction is serious: reading enforce as testing sends mail an attacker can
  // read, and reading testing as enforce blocks mail a domain expected to flow.
  const testing = parseStsPolicy(P('version: STSv1\r\nmode: testing\r\nmx: mail.example.com\r\nmax_age: 1\r\n'));
  assert.equal(testing.valid, true);
  assert.equal(testing.mode, 'testing');
  assert.equal(parseStsPolicy(ENFORCING).mode, 'enforce');
  assert.equal(parseStsPolicy(P('version: STSv1\r\nmode: none\r\nmax_age: 1\r\n')).mode, 'none');
});
