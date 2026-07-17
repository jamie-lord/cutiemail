/**
 * Inbound DMARC (RFC 7489): SPF/DKIM must not only PASS but be ALIGNED with the RFC
 * 5322 From domain. Composes the tested parseDmarcRecord + checkAlignment with a From
 * extractor and an injected DNS map, covering aligned pass (via DKIM or SPF), a passing-
 * but-unaligned identifier (fail), relaxed sub-domain alignment through the org-domain
 * fallback, and the org-domain heuristic itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDmarc, organizationalDomain } from './dmarc-inbound.ts';

const msg = (fromDomain: string): Buffer => Buffer.from(`From: Alice <alice@${fromDomain}>\r\nSubject: hi\r\n\r\nbody\r\n`, 'latin1');
const dmarcAt = (records: Record<string, string>) => async (name: string) => (records[name] !== undefined ? [records[name]!] : []);

test('the organizational-domain heuristic handles common and multi-part TLDs', () => {
  assert.equal(organizationalDomain('mail.google.com'), 'google.com');
  assert.equal(organizationalDomain('example.com'), 'example.com');
  assert.equal(organizationalDomain('a.b.example.co.uk'), 'example.co.uk');
});

test('DMARC passes when an aligned DKIM or SPF identifier passed', async () => {
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject' });
  const viaDkim = await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(viaDkim.verdict, 'pass');
  assert.equal(viaDkim.policy, 'reject', 'the published policy is reported');

  const viaSpf = await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: [], spfResult: 'pass', spfDomain: 'example.com', resolveTxt: rec });
  assert.equal(viaSpf.verdict, 'pass');
});

test('a passing but UNALIGNED identifier does not satisfy DMARC', async () => {
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=quarantine' });
  // DKIM passed but for a different domain; SPF failed. DMARC fails.
  const out = await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: ['unrelated.test'], spfResult: 'fail', spfDomain: 'unrelated.test', resolveTxt: rec });
  assert.equal(out.verdict, 'fail');
});

test('relaxed alignment matches a subdomain via the organizational-domain fallback', async () => {
  // The From is mail.example.com; no record there, but example.com publishes one, and
  // DKIM d=example.com is org-aligned with mail.example.com under relaxed mode.
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=none' });
  const out = await checkDmarc({ rawMessage: msg('mail.example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(out.verdict, 'pass');
});

test('strict alignment requires an exact domain match', async () => {
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject; adkim=s' });
  // DKIM d=example.com but From is mail.example.com — not an exact match under adkim=s.
  const out = await checkDmarc({ rawMessage: msg('mail.example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: dmarcAt({ '_dmarc.mail.example.com': 'v=DMARC1; p=reject; adkim=s' }) });
  assert.equal(out.verdict, 'fail', 'strict adkim rejects a subdomain d=');
  void rec;
});

test('no DMARC record is "none"; a DNS error is "temperror"', async () => {
  assert.equal((await checkDmarc({ rawMessage: msg('nodmarc.test'), dkimPassedDomains: ['nodmarc.test'], spfResult: 'none', spfDomain: '', resolveTxt: async () => [] })).verdict, 'none');
  assert.equal(
    (
      await checkDmarc({
        rawMessage: msg('x.test'),
        dkimPassedDomains: ['x.test'],
        spfResult: 'none',
        spfDomain: '',
        resolveTxt: async () => {
          throw new Error('SERVFAIL');
        },
      })
    ).verdict,
    'temperror',
  );
});
