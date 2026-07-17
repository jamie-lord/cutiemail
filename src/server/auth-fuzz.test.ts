/**
 * Fuzz the inbound-auth composition (checkSpf / verifyDkim / checkDmarc). These parse
 * attacker-controlled records and headers straight off the internet, so the contract
 * that matters is: NEVER throw, always return a well-formed verdict. The underlying
 * crypto/parsers are vector-pinned elsewhere; this hammers the glue that ties them
 * together with malformed, truncated, and adversarial inputs.
 *
 * Deterministic: a small seeded PRNG drives the mutations so a failure reproduces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpf, type SpfResult } from '../auth/spf-check.ts';
import { verifyDkim } from './dkim-inbound.ts';
import { checkDmarc } from './dmarc-inbound.ts';

/** A tiny deterministic PRNG (mulberry32) — no Math.random, so runs are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'v=spf1', 'v=DKIM1', 'v=DMARC1', 'ip4:', 'ip6:', 'a:', 'mx:', 'include:', 'redirect=', 'all', '-all', '~all',
  'p=', 'k=rsa', 'k=ed25519', 'adkim=', 'aspf=', 'sp=', 'pct=', ':', ';', '=', '/', '//', '.', '..', '@', '<', '>',
  '::ffff:', '1.2.3.4', '2001:db8::', 'reject', 'quarantine', 'none', 'x'.repeat(40), '0'.repeat(20), '%{d}', ' ', '\t',
  'b=', 'bh=', 'h=from:subject', 'd=example.com', 's=sel', 'c=relaxed/relaxed', 'a=rsa-sha256', String.fromCharCode(0),
];

function randomRecord(rng: () => number): string {
  const n = 1 + Math.floor(rng() * 12);
  let s = '';
  for (let i = 0; i < n; i++) s += FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)]! + (rng() < 0.5 ? ' ' : '');
  return s;
}

const VALID_SPF: readonly SpfResult[] = ['pass', 'fail', 'softfail', 'neutral', 'none', 'permerror', 'temperror'];

test('checkSpf never throws and always returns a valid result on fuzzed records', async () => {
  const rng = prng(0x5f1);
  for (let i = 0; i < 500; i++) {
    const record = randomRecord(rng);
    const resolvers = {
      txt: async (): Promise<string[]> => [record],
      a: async (): Promise<string[]> => (rng() < 0.5 ? ['1.2.3.4'] : ['::ffff:1.2.3.4']),
      mx: async (): Promise<string[]> => (rng() < 0.5 ? ['mail.x.test'] : []),
    };
    const ip = rng() < 0.5 ? '1.2.3.4' : '::ffff:5.6.7.8';
    let result: SpfResult;
    try {
      result = await checkSpf(ip, 'fuzz.test', resolvers);
    } catch (e) {
      throw new Error(`checkSpf threw on record ${JSON.stringify(record)}: ${String(e)}`);
    }
    assert.ok(VALID_SPF.includes(result), `unexpected SPF result ${result} for ${JSON.stringify(record)}`);
  }
});

test('verifyDkim never throws on fuzzed DKIM-Signature headers', async () => {
  const rng = prng(0xd11a);
  const verdicts = new Set(['pass', 'fail', 'none', 'temperror', 'permerror']);
  for (let i = 0; i < 500; i++) {
    const sig = randomRecord(rng);
    const message = Buffer.from(`DKIM-Signature: ${sig}\r\nFrom: a@fuzz.test\r\nSubject: x\r\n\r\nbody\r\n`, 'latin1');
    let out: { verdict: string };
    try {
      out = await verifyDkim(message, async () => (rng() < 0.5 ? Buffer.from(randomRecord(rng), 'latin1') : null));
    } catch (e) {
      throw new Error(`verifyDkim threw on ${JSON.stringify(sig)}: ${String(e)}`);
    }
    assert.ok(verdicts.has(out.verdict), `unexpected DKIM verdict ${out.verdict}`);
  }
});

test('checkDmarc never throws on fuzzed records and From headers', async () => {
  const rng = prng(0xd3a2);
  const verdicts = new Set(['pass', 'fail', 'none', 'temperror']);
  for (let i = 0; i < 500; i++) {
    const from = `${FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)]}@${randomRecord(rng).replace(/\s/g, '')}`;
    const message = Buffer.from(`From: ${from}\r\nSubject: x\r\n\r\nbody\r\n`, 'latin1');
    let out: { verdict: string };
    try {
      out = await checkDmarc({
        rawMessage: message,
        dkimPassedDomains: rng() < 0.5 ? [randomRecord(rng).replace(/\s/g, '')] : [],
        spfResult: rng() < 0.5 ? 'pass' : 'fail',
        spfDomain: randomRecord(rng).replace(/\s/g, ''),
        resolveTxt: async () => [randomRecord(rng)],
      });
    } catch (e) {
      throw new Error(`checkDmarc threw on From ${JSON.stringify(from)}: ${String(e)}`);
    }
    assert.ok(verdicts.has(out.verdict), `unexpected DMARC verdict ${out.verdict}`);
  }
});
