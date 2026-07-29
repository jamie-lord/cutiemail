/**
 * DMARC policy discovery against the From headers RFC 5322 actually permits.
 *
 * The author extractor's contract is that it yields the address "the way a compliant MUA
 * DISPLAYS it". It did not, for three forms the grammar allows and reference parsers resolve
 * to a plain address:
 *
 *  - `victim@bank.com,` — obs-mbox-list (§4.4) makes a trailing comma a ONE-mailbox list.
 *  - `Accounts: victim@bank.com;` — group syntax, permitted in From by RFC 6854.
 *  - `victim@bank .com` — obs-domain (§4.4) is `atom *("." atom)` with CFWS around atoms.
 *
 * Each produced a "domain" containing a comma, semicolon or space. c-ares rejects such a name
 * with EBADNAME, which the resolver correctly rethrows, which `checkDmarc` maps to temperror —
 * and enforcement only acts on `fail`, so a message spoofing a p=reject domain reached the
 * INBOX while the recipient's client showed the spoofed address.
 *
 * Separately, RFC 9989 §11.5 names the multi-domain variant outright: an attacker appends their
 * own policy-less mailbox, the *last* one wins policy selection while the *first* is displayed,
 * and the spoof is detected as a failure and then not enforced. §11.5 prescribes evaluating
 * each domain and applying the strictest failing policy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDmarc } from './dmarc-inbound.ts';
import { authorDomains, domainOfAddrSpec } from '../message/from-author.ts';
import { authRequirement, type AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

/** A zone where bank.test publishes p=reject and nothing else publishes anything. */
const zone = new Map<string, readonly string[]>([['_dmarc.bank.test', ['v=DMARC1; p=reject']]]);

/** Reject a syntactically impossible query name the way a real resolver does. */
const resolveTxt = async (name: string): Promise<readonly string[]> => {
  if (!/^[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$/.test(name)) {
    const e = new Error(`queryTxt EBADNAME ${name}`) as Error & { code?: string };
    e.code = 'EBADNAME';
    throw e;
  }
  return zone.get(name) ?? [];
};

const evaluate = (fromValue: string) =>
  checkDmarc({
    rawMessage: Buffer.from(`From: ${fromValue}\r\nSubject: t\r\n\r\nbody\r\n`, 'latin1'),
    dkimPassedDomains: [],
    spfResult: 'fail',
    spfDomain: '',
    resolveTxt,
  });

test('a published p=reject is enforced for every From form a compliant parser resolves', async () => {
  const control = await evaluate('victim@bank.test');
  assert.equal(control.verdict, 'fail', 'control: an unaligned message fails');
  assert.equal(control.policy, 'reject', 'control: the published policy is discovered');

  for (const form of [
    'victim@bank.test,', // obs-mbox-list, one mailbox
    'Accounts: victim@bank.test;', // RFC 6854 group syntax
    'victim@bank .test', // obs-domain with CFWS between atoms
    '  victim@bank.test  ',
  ]) {
    const out = await evaluate(form);
    assert.equal(out.verdict, 'fail', `${form}: must still fail DMARC`);
    assert.equal(
      out.policy,
      'reject',
      `${form}: the published p=reject must be discovered, not lost to a malformed query`,
    );
  }
});

test('a From that yields no usable author domain is a failure, not an absence of policy', async () => {
  // Nothing here resolves to an address a receiver could authenticate. Reporting `none` let
  // enforcement skip it, so the most malformed input got the most lenient handling.
  for (const form of ['victim@bank.test <>', '<>', 'not-an-address']) {
    const out = await evaluate(form);
    assert.equal(out.verdict, 'fail', `${form}: an unparseable author must not read as authentic`);
  }
});

test('the strictest policy among multiple From domains governs (RFC 9989 §11.5)', async () => {
  cites('R-9989-11.5-a');
  // The attacker appends their own policy-less mailbox. The victim's address is displayed
  // first; the last one used to pick the policy.
  const out = await evaluate('victim@bank.test, attacker@nowhere.test');
  assert.equal(out.verdict, 'fail', 'more than one author mailbox is never authentic');
  assert.equal(
    out.policy,
    'reject',
    'the strictest published policy across author domains governs, not the last one listed',
  );

  // And the same with angle-addrs, where the last angle-addr used to win outright.
  const angled = await evaluate('"Bank" <victim@bank.test>, <attacker@nowhere.test>');
  assert.equal(angled.policy, 'reject', 'angle-addr form selects the same policy');
});

test('the number of author domains queried is bounded', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `u${i}@d${i}.test`).join(', ');
  const queried: string[] = [];
  const counting = async (name: string): Promise<readonly string[]> => {
    queried.push(name);
    return resolveTxt(name);
  };
  await checkDmarc({
    rawMessage: Buffer.from(`From: ${many}\r\n\r\nbody\r\n`, 'latin1'),
    dkimPassedDomains: [],
    spfResult: 'fail',
    spfDomain: '',
    resolveTxt: counting,
  });
  // §11.5 warns that evaluating every domain is itself a denial-of-service vector.
  assert.ok(queried.length <= 16, `an unauthenticated peer bought ${queried.length} DNS queries`);
});

test('domainOfAddrSpec refuses anything that cannot be a DNS name', () => {
  assert.equal(domainOfAddrSpec('a@bank.test'), 'bank.test');
  assert.equal(domainOfAddrSpec('a@BANK.test.'), 'bank.test', 'trailing root dot is stripped');
  assert.equal(domainOfAddrSpec('a@bank .test'), 'bank.test', 'obs-domain CFWS is folded out');
  for (const bad of ['a@bank.test,', 'a@bank.test;', 'a@bank..test', 'a@-bank.test', 'a@', 'no-at']) {
    assert.equal(domainOfAddrSpec(bad), null, `${bad} must not become a query name`);
  }
});

test('authorDomains reports every author mailbox, so none can hide behind another', () => {
  assert.deepEqual(authorDomains('a@x.test'), ['x.test']);
  assert.deepEqual(authorDomains('a@x.test,'), ['x.test'], 'obs-mbox-list trailing comma');
  assert.deepEqual(authorDomains('G: a@x.test;'), ['x.test'], 'group syntax');
  assert.deepEqual(authorDomains('a@x.test, b@y.test'), ['x.test', 'y.test']);
  assert.deepEqual(
    authorDomains('"X, Y" <a@x.test>'),
    ['x.test'],
    'a comma inside a quoted display-name is not a separator',
  );
});
