/**
 * Inbound DMARC (RFC 7489): SPF/DKIM must not only PASS but be ALIGNED with the RFC
 * 5322 From domain. Composes the tested parseDmarcRecord + checkAlignment with a From
 * extractor and an injected DNS map, covering aligned pass (via DKIM or SPF), a passing-
 * but-unaligned identifier (fail), relaxed sub-domain alignment through the org-domain
 * fallback, and the org-domain heuristic itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDmarc, organizationalDomain, policyAncestors } from './dmarc-inbound.ts';
import { authRequirement, type AuthRequirementId } from '../register/auth/index.ts';

/** Traceability: naming the requirement a test covers is a compile error if it does not exist. */
const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

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

test('a message with TWO From headers cannot pass DMARC (display-spoof defence, RFC 5322 §3.6.1)', async () => {
  const rec = dmarcAt({ '_dmarc.evil.test': 'v=DMARC1; p=reject' });
  // The attacker aligns the FIRST From (their own domain) while a lenient MUA may show
  // the SECOND (the victim's). DMARC must refuse to pass this rather than bless it.
  const two = Buffer.from('From: attacker@evil.test\r\nFrom: ceo@bank.test\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: two, dkimPassedDomains: ['evil.test'], spfResult: 'pass', spfDomain: 'evil.test', resolveTxt: rec });
  assert.equal(out.verdict, 'fail', 'a duplicate-From message is a DMARC fail, never a pass');
});

test('DMARC aligns on the DISPLAYED From address, not a decoy hidden in a quoted display-name', async () => {
  // The full-DMARC-bypass class: the attacker owns evil.com (DKIM
  // d=evil.com passes) and buries <x@evil.com> in the quoted display-name, while the real
  // angle-addr every MUA shows is victim@bank.com. The old first-`<...>` match aligned on
  // evil.com → forged dmarc=pass. The fix aligns on the displayed bank.com.
  const rec = dmarcAt({ '_dmarc.evil.com': 'v=DMARC1; p=none', '_dmarc.bank.com': 'v=DMARC1; p=reject' });
  const spoof = Buffer.from('From: "Security <x@evil.com>" <victim@bank.com>\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: spoof, dkimPassedDomains: ['evil.com'], spfResult: 'pass', spfDomain: 'evil.com', resolveTxt: rec });
  assert.equal(out.fromDomain, 'bank.com', 'aligns on the displayed victim@bank.com, not the decoy evil.com');
  assert.equal(out.verdict, 'fail', "the attacker's evil.com auth is not aligned with bank.com — no forged pass");
});

test('a ( planted inside the quoted display-name does not reopen the From-domain spoof', async () => {
  // Stripping comments BEFORE quoted-strings would let a `(` inside the quoted
  // display-name be mis-read as a comment — unbalancing the closing `"` and re-exposing the
  // attacker angle-addr. Both variants must align on the DISPLAYED bank.com.
  const rec = dmarcAt({ '_dmarc.attacker.com': 'v=DMARC1; p=none', '_dmarc.bank.com': 'v=DMARC1; p=reject' });
  // Variant A: decoy angle-addr + a stray ( inside the quoted display-name.
  const a = Buffer.from('From: "<a@attacker.com>(" <victim@bank.com>\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const outA = await checkDmarc({ rawMessage: a, dkimPassedDomains: ['attacker.com'], spfResult: 'pass', spfDomain: 'attacker.com', resolveTxt: rec });
  assert.equal(outA.fromDomain, 'bank.com', 'aligns on displayed bank.com, not the quoted decoy attacker.com');
  assert.equal(outA.verdict, 'fail');
  // Variant B (no attacker infra): a bare "(" quoted display-name used to yield null → p=reject skipped.
  const b = Buffer.from('From: "(" <victim@bank.com>\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const outB = await checkDmarc({ rawMessage: b, dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(outB.fromDomain, 'bank.com', 'the From domain is still extracted (was null) so p=reject IS fetched');
  assert.equal(outB.policy, 'reject', "bank.com's p=reject is enforced, not skipped");
});

test('the same From-spoof hidden in a COMMENT is also defeated', async () => {
  const rec = dmarcAt({ '_dmarc.bank.com': 'v=DMARC1; p=reject' });
  const spoof = Buffer.from('From: (x <a@evil.com>) victim@bank.com\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: spoof, dkimPassedDomains: ['evil.com'], spfResult: 'pass', spfDomain: 'evil.com', resolveTxt: rec });
  assert.equal(out.fromDomain, 'bank.com');
  assert.equal(out.verdict, 'fail');
});

test('a legitimate display-name with an angle-addr still aligns and passes (no over-strict regression)', async () => {
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject' });
  const ok = Buffer.from('From: "Alice, Example" <alice@example.com>\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: ok, dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(out.fromDomain, 'example.com');
  assert.equal(out.verdict, 'pass');
});

test('a duplicate-From fail reports the published policy so it is enforced to Junk, not INBOX', async () => {
  // The fromCount>1 path used to short-circuit with policy=null, so
  // main.ts (which enforces on a quarantine/reject policy) delivered it to INBOX — the
  // more deceptive duplicate-From spoof evading the enforcement a single-From spoof hit.
  const rec = dmarcAt({ '_dmarc.bank.test': 'v=DMARC1; p=reject' });
  const two = Buffer.from('From: ceo@bank.test\r\nFrom: x@evil.test\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: two, dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(out.verdict, 'fail');
  assert.equal(out.policy, 'reject', 'the policy is now fetched (was null) so the failure is enforced');
});

test('a From with illegal whitespace before the colon is still seen (not hidden from DMARC)', async () => {
  // "From :" is malformed but a lenient MUA reads it as From; DMARC must see it too, so
  // the header name is trimmed before matching. Here the aligned identity makes it pass.
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=none' });
  const weird = Buffer.from('From : Alice <alice@example.com>\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: weird, dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(out.verdict, 'pass', 'the From is recognized despite the WSP before the colon');
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

test('the expanded suffix list prevents FALSE alignment under a multi-part ccTLD', async () => {
  // Two unrelated registrants under .co.za must NOT be treated as the same org domain
  // (that would be a false DMARC pass). From is victim.co.za; DKIM d= attacker.co.za.
  assert.equal(organizationalDomain('victim.co.za'), 'victim.co.za');
  assert.equal(organizationalDomain('attacker.co.za'), 'attacker.co.za');
  const rec = dmarcAt({ '_dmarc.victim.co.za': 'v=DMARC1; p=reject' });
  const out = await checkDmarc({ rawMessage: msg('victim.co.za'), dkimPassedDomains: ['attacker.co.za'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(out.verdict, 'fail', 'a different registrant under the same ccTLD is not aligned');
});

test('a subdomain governed by the org record reports the subdomain policy sp= (RFC 7489 §6.6.3)', async () => {
  // From mail.example.com has no own record; example.com publishes p=none; sp=quarantine.
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=none; sp=quarantine' });
  const sub = await checkDmarc({ rawMessage: msg('mail.example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(sub.policy, 'quarantine', 'the subdomain policy applies to a subdomain From');
  // The org domain itself uses p=, not sp=.
  const rec2 = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject; sp=quarantine' });
  const org = await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec2 });
  assert.equal(org.policy, 'reject', 'the org domain itself uses p=');
});

test('From extraction uses the angle-addr (not a spoofed display name) and strips a trailing dot', async () => {
  const rec = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject; adkim=s' });
  // A fake domain in the display name must not be used — the real angle-addr wins.
  const spoof = Buffer.from('From: "billing@paypal.com" <alice@example.com>\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const s = await checkDmarc({ rawMessage: spoof, dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(s.fromDomain, 'example.com', 'the angle-addr domain is authoritative, not the display name');
  // A root-anchoring trailing dot aligns strictly with a dot-less d=.
  const dotted = Buffer.from('From: alice@example.com.\r\nSubject: x\r\n\r\nb\r\n', 'latin1');
  const d = await checkDmarc({ rawMessage: dotted, dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(d.fromDomain, 'example.com', 'the trailing dot is stripped');
  assert.equal(d.verdict, 'pass', 'strict alignment holds despite the trailing dot');
});

test('a SINGLE From header carrying a mailbox-list cannot pass DMARC (RFC 7489 §6.6.1, RFC 5322 §3.6.1)', async () => {
  // The single-header evasion of the duplicate-From defence: `From: victim, attacker` in ONE
  // header. The attacker owns evil.com (aligned DKIM d=evil.com) as the SECOND mailbox, while a
  // lenient MUA may render the FIRST, victim@bank.com. The old count=froms.length reported 1, so
  // domainOfAddrSpec's lastIndexOf('@') aligned evil.com → a forged dmarc=pass. Now the mailbox
  // count makes it a display-spoof fail, and bank.com's p=reject is fetched so it lands in Junk.
  const rec = dmarcAt({ '_dmarc.bank.com': 'v=DMARC1; p=reject', '_dmarc.evil.com': 'v=DMARC1; p=none' });
  const list = Buffer.from('From: victim@bank.com, x@evil.com\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const out = await checkDmarc({ rawMessage: list, dkimPassedDomains: ['evil.com'], spfResult: 'pass', spfDomain: 'evil.com', resolveTxt: rec });
  assert.equal(out.verdict, 'fail', 'a single-header mailbox-list is a DMARC fail, never a pass');
  // Control: the genuine single mailbox with the same aligned DKIM passes.
  const genuine = Buffer.from('From: x@evil.com\r\nSubject: hi\r\n\r\nbody\r\n', 'latin1');
  const ok = await checkDmarc({ rawMessage: genuine, dkimPassedDomains: ['evil.com'], spfResult: 'pass', spfDomain: 'evil.com', resolveTxt: rec });
  assert.equal(ok.verdict, 'pass', 'the single-mailbox control still passes');
});

test('MULTIPLE published DMARC records → no policy applied (RFC 7489 §6.6.3 step 5)', async () => {
  // Two v=DMARC1 records at _dmarc.<from>; §6.6.3 step 5 terminates discovery with no policy.
  // The old txts.find() took the FIRST and evaluated against it (SPF already rejects this case).
  const two = async (name: string) => (name === '_dmarc.example.com' ? ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] : []);
  const out = await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: ['example.com'], spfResult: 'pass', spfDomain: 'example.com', resolveTxt: two });
  assert.equal(out.verdict, 'none', 'multiple records is treated as no DMARC policy');
  assert.equal(out.policy, null);
  // Control: exactly one record and the same aligned auth passes.
  const one = dmarcAt({ '_dmarc.example.com': 'v=DMARC1; p=reject' });
  assert.equal((await checkDmarc({ rawMessage: msg('example.com'), dkimPassedDomains: ['example.com'], spfResult: 'none', spfDomain: '', resolveTxt: one })).verdict, 'pass');
});

test('an IDN U-label From aligns with an A-label d= and is not junked (RFC 6376 §3.5 A-labels)', async () => {
  // Legit IDN mail: the From is written with U-labels (bücher.example) but the DKIM d= is the
  // A-label (xn--bcher-kva.example) as required on the wire. The old raw compare made them
  // unequal → unaligned → junked under p=quarantine/reject. Alignment now normalizes both sides.
  const uFrom = 'bücher.example';
  const aLabel = 'xn--bcher-kva.example';
  // The published record is fetched at the A-label _dmarc name (the query is A-labelled too).
  const rec = dmarcAt({ [`_dmarc.${aLabel}`]: 'v=DMARC1; p=reject' });
  const message = Buffer.from(`From: Bücher <buch@${uFrom}>\r\nSubject: hi\r\n\r\nbody\r\n`, 'latin1');
  const viaDkim = await checkDmarc({ rawMessage: message, dkimPassedDomains: [aLabel], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.equal(viaDkim.verdict, 'pass', 'U-label From aligns with the A-label DKIM d=');
  // Reverse pairing: an A-label From with a U-label SPF domain aligns too.
  const aMessage = Buffer.from(`From: buch@${aLabel}\r\nSubject: hi\r\n\r\nbody\r\n`, 'latin1');
  const viaSpf = await checkDmarc({ rawMessage: aMessage, dkimPassedDomains: [], spfResult: 'pass', spfDomain: uFrom, resolveTxt: rec });
  assert.equal(viaSpf.verdict, 'pass', 'A-label From aligns with a U-label SPF identifier');
});

// -- RFC 9989 §4.10 policy discovery ------------------------------------------------------
// The replacement for 7489's single jump to the organizational domain. See ADR 0027.

test('policyAncestors visits shallowest-first and never exceeds RFC 9989 §4.10\'s eight queries', () => {
  cites('R-9989-4.10-a');
  cites('R-9989-4.10.2-a');
  // Shallowest first, because §4.10.2 selects "the DMARC Policy Record found at the name
  // with the fewest number of labels" — NOT the most specific one.
  assert.deepEqual(policyAncestors('a.b.example.com', 'example.com'), ['example.com', 'b.example.com']);
  // Nothing to walk when the From domain IS the organizational domain: one query, as before.
  assert.deepEqual(policyAncestors('example.com', 'example.com'), []);
  assert.deepEqual(policyAncestors('mail.example.com', 'example.com'), ['example.com']);
  // Multi-part public suffix: the floor is the registered domain, not the suffix.
  assert.deepEqual(policyAncestors('a.example.co.uk', 'example.co.uk'), ['example.co.uk']);

  // The DoS shortcut: an attacker-chosen From cannot buy a query per label. The walk plus
  // the Author Domain query itself must stay within the eight the RFC budgets.
  const hostile = `${'x.'.repeat(200)}example.com`;
  const names = policyAncestors(hostile, 'example.com');
  assert.ok(names.length + 1 <= 8, `walk cost ${names.length + 1} queries, budget is 8`);
  // ...and it still reaches the shallow names that actually matter.
  assert.equal(names[0], 'example.com');
});

test('a policy published at an INTERMEDIATE name is applied — the case RFC 7489 discovery skips', async () => {
  cites('R-9989-4.10.1-a');
  cites('R-9989-4.10.1-b');
  // 7489 §6.6.3 queries the Author Domain then jumps to the organizational domain, so a
  // policy published in between is never seen. Here the apex publishes nothing at all.
  const rec = dmarcAt({ '_dmarc.corp.example.com': 'v=DMARC1; p=reject' });
  const out = await checkDmarc({
    rawMessage: msg('alerts.corp.example.com'),
    dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec,
  });
  assert.equal(out.verdict, 'fail');
  assert.equal(out.policy, 'reject', 'the intermediate policy governs; 7489 discovery applied none at all');

  // And sp= governs when the record came from above the Author Domain.
  const withSp = dmarcAt({ '_dmarc.corp.example.com': 'v=DMARC1; p=reject; sp=quarantine' });
  const sub = await checkDmarc({
    rawMessage: msg('alerts.corp.example.com'),
    dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: withSp,
  });
  assert.equal(sub.policy, 'quarantine');
});

test('when several ancestors publish, the SHALLOWEST wins (§4.10.2), not the most specific', async () => {
  cites('R-9989-4.10.2-a');
  // The counter-intuitive half of the tree walk, and the reason the walk queries downward.
  // Getting this backwards would silently apply the wrong domain owner's policy.
  const rec = dmarcAt({
    '_dmarc.corp.example.com': 'v=DMARC1; p=none',
    '_dmarc.example.com': 'v=DMARC1; p=reject',
  });
  const out = await checkDmarc({
    rawMessage: msg('alerts.corp.example.com'),
    dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec,
  });
  assert.equal(out.policy, 'reject', 'example.com has the fewest labels, so its record is the one selected');
});

test('a record at the Author Domain outranks every ancestor and costs exactly one query', async () => {
  cites('R-9989-4.10.1-a');
  const asked: string[] = [];
  const rec = async (name: string): Promise<readonly string[]> => {
    asked.push(name);
    if (name === '_dmarc.alerts.corp.example.com') return ['v=DMARC1; p=none'];
    if (name === '_dmarc.example.com') return ['v=DMARC1; p=reject'];
    return [];
  };
  const out = await checkDmarc({
    rawMessage: msg('alerts.corp.example.com'),
    dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec,
  });
  assert.equal(out.policy, 'none', '§4.10.1: the Author Domain record is applied outright');
  assert.deepEqual(asked, ['_dmarc.alerts.corp.example.com'], 'no ancestor is queried once the Author Domain answers');
});

test('the walk never costs more than the old fallback for an ordinary two-label sender', async () => {
  const asked: string[] = [];
  const rec = async (name: string): Promise<readonly string[]> => {
    asked.push(name);
    return name === '_dmarc.example.com' ? ['v=DMARC1; p=reject'] : [];
  };
  await checkDmarc({ rawMessage: msg('mail.example.com'), dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: rec });
  assert.deepEqual(asked, ['_dmarc.mail.example.com', '_dmarc.example.com'], 'the common case is the same two lookups it always was');
});

test('RFC 9989 §4.7 test mode demotes the policy one level, so a domain mid-rollout is not junked', async () => {
  cites('R-9989-4.7-a');
  const under = async (record: string): Promise<{ policy: string | null; publishedPolicy: string | null; testMode: boolean }> => {
    const out = await checkDmarc({
      rawMessage: msg('example.com'),
      dkimPassedDomains: [], spfResult: 'none', spfDomain: '', resolveTxt: dmarcAt({ '_dmarc.example.com': record }),
    });
    assert.equal(out.verdict, 'fail', 'nothing aligns, so every case below is a DMARC failure');
    return out;
  };

  // quarantine + t=y => none: main.ts enforces on `policy`, so this reaches the INBOX.
  const testingQuarantine = await under('v=DMARC1; p=quarantine; t=y');
  assert.equal(testingQuarantine.policy, 'none');
  assert.equal(testingQuarantine.publishedPolicy, 'quarantine', 'the trace still shows what the zone says');
  assert.equal(testingQuarantine.testMode, true);

  // reject + t=y => quarantine: still junked, but not treated as the stronger policy.
  assert.equal((await under('v=DMARC1; p=reject; t=y')).policy, 'quarantine');

  // t=n and a garbled value both leave the policy alone: only an explicit "y" disarms it,
  // so a typo cannot silently switch enforcement off.
  for (const t of ['n', 'yes', 'Y', '']) {
    assert.equal((await under(`v=DMARC1; p=quarantine; t=${t}`)).policy, 'quarantine', `t=${t} must not demote`);
  }
  assert.equal((await under('v=DMARC1; p=quarantine')).policy, 'quarantine', 'absent t= is the default n');
});
