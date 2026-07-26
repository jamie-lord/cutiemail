/**
 * RFC 7208 §4.6.4 and §5.1 — the limits that make SPF safe to evaluate on an unauthenticated
 * inbound connection.
 *
 * The threat model is what makes these worth testing carefully. Every DNS-querying mechanism in a
 * sender's record costs us a lookup; the record is published by whoever owns the domain; and the
 * domain is chosen by the peer connecting to port 25. So a hostile sender writes a record that fans
 * out, and every message they send spends our resolver budget. The limits are the defence.
 *
 * The verdict half matters as much as the count. A server that stops looking things up and returns
 * "neutral" has converted a resource control into an authentication bypass: the sender published a
 * record too expensive to evaluate and thereby escaped being judged by it. permerror is the answer,
 * and it is one DMARC treats as a failure to authenticate rather than as an absence of policy.
 *
 * The resolvers here COUNT, so the assertions are about what a record actually costs us rather than
 * only about the verdict it produces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpf, type SpfResolvers } from './spf-check.ts';
import { authRequirement, type AuthRequirementId } from '../register/auth/index.ts';

const cites = (id: AuthRequirementId): void => assert.ok(authRequirement(id).id === id);

/** See the note in imap-conformance-mailbox.integration.test.ts. */
const GAP = (why: string): { todo: string } => ({ todo: why });

const SENDER_IP = '198.51.100.7';

interface CountingResolvers extends SpfResolvers {
  readonly counts: { txt: number; a: number; mx: number };
}

/** Resolvers over a fixed zone, counting every query. Anything unlisted resolves to nothing. */
function zone(records: {
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  mx?: Record<string, string[]>;
}): CountingResolvers {
  const counts = { txt: 0, a: 0, mx: 0 };
  return {
    counts,
    async txt(name) {
      counts.txt++;
      return records.txt?.[name] ?? [];
    },
    async a(name) {
      counts.a++;
      return records.a?.[name] ?? [];
    },
    async mx(name) {
      counts.mx++;
      return records.mx?.[name] ?? [];
    },
  };
}

test('a record needing more than ten DNS-querying terms is a permerror', async () => {
  cites('R-7208-4.6.4-a');
  cites('R-7208-4.6.4-b');
  // Twelve `include` terms, each naming a record that evaluates to fail. Every one costs a lookup
  // and none of them MATCHES, so evaluation walks the whole list — which is what puts the term
  // count, and nothing else, in charge of the outcome. (`exists` would be the obvious choice and is
  // the wrong one: it matches whenever its target resolves, so the record would pass on the first
  // term and never reach the limit at all.)
  const txt: Record<string, string[]> = {
    'sender.test': [`v=spf1 ${Array.from({ length: 12 }, (_, i) => `include:i${i}.test`).join(' ')} -all`],
  };
  for (let i = 0; i < 12; i++) txt[`i${i}.test`] = ['v=spf1 -all'];
  const resolvers = zone({ txt });

  const result = await checkSpf(SENDER_IP, 'sender.test', resolvers);
  // Not "neutral", not "fail": a record too expensive to evaluate must not escape being judged.
  assert.equal(result, 'permerror', 'exceeding the ten-term limit is a permerror');
  assert.ok(resolvers.counts.txt <= 12, `and we stop looking things up rather than finishing: ${resolvers.counts.txt}`);
});

test('the ten-term limit is cumulative across includes, not per record', GAP(
  'RFC 7208 §5.2 MUST (result table): an "include" whose recursive evaluation returns permerror '
  + 'must itself return permerror; this implementation treats any non-pass as "not match", so the '
  + 'permerror is swallowed and the outer record carries on to its "-all" and answers fail.\n\n'
  + 'That is not only a wrong verdict. It is how the ten-lookup limit (§4.6.4) gets escaped: the '
  + 'shared budget is blown inside an included record, the error is discarded, and evaluation '
  + 'continues — so the limit is advisory rather than enforced, and a sender who publishes an '
  + 'expensive fan-out escapes being judged by their own record. temperror already propagates '
  + 'correctly; permerror and none do not. An unmirrored sibling guard.',
), async () => {
  cites('R-7208-5.2-a');
  cites('R-7208-4.6.4-a');
  // The mistake this catches: a per-record counter lets a chain of includes each spend nine
  // lookups, so the total is unbounded while every individual record looks modest.
  const txt: Record<string, string[]> = {
    'sender.test': ['v=spf1 include:a.test include:b.test include:c.test -all'],
  };
  for (const name of ['a', 'b', 'c']) {
    txt[`${name}.test`] = [`v=spf1 include:x1.${name}.test include:x2.${name}.test include:x3.${name}.test -all`];
    for (const n of [1, 2, 3]) txt[`x${n}.${name}.test`] = ['v=spf1 -all'];
  }
  // 3 + 9 = 12 querying terms in total, and no single record names more than three.
  const resolvers = zone({ txt });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'permerror', 'the budget is shared across the whole evaluation');
});

test('a record inside the limit still resolves normally', async () => {
  cites('R-7208-4-a');
  // The negative control for every limit in this file: a modest record must not be refused, or the
  // cases above would pass against an implementation that permerrors on everything.
  const resolvers = zone({
    txt: { 'sender.test': ['v=spf1 include:relay.test -all'], 'relay.test': [`v=spf1 ip4:${SENDER_IP} -all`] },
  });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'pass');
  assert.equal(resolvers.counts.txt, 2, 'and cost exactly the two lookups it names');
});

test('more than two void lookups is refused', async () => {
  cites('R-7208-4.6.4-e');
  // A void lookup returns NXDOMAIN or no answer. Bounding them catches the record that stays under
  // ten terms while pointing all of them at names that do not resolve: cheap to publish, slow for
  // us, and invisible to a count of successful lookups.
  const resolvers = zone({
    txt: { 'sender.test': ['v=spf1 exists:v1.test exists:v2.test exists:v3.test exists:v4.test -all'] },
  });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'permerror', 'the void-lookup budget is enforced');

  // Two voids is within budget, so the evaluation completes and reaches the final `-all`.
  const withinBudget = zone({ txt: { 'sender.test': ['v=spf1 exists:v1.test exists:v2.test -all'] } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', withinBudget), 'fail', 'two voids is allowed, and evaluation continues');
});

test('an mx mechanism naming more than ten hosts is a permerror', GAP(
  'RFC 7208 §4.6.4 MUST: an "mx" mechanism whose MX record names more than ten hosts is evaluated '
  + 'in full rather than producing a permerror. One "mx" term costs one against the ten-term budget '
  + 'but can fan out to an unbounded number of address lookups, which is the nested limit this '
  + 'requirement exists to impose — and the sender publishes the MX record.',
), async () => {
  cites('R-7208-4.6.4-c');
  const hosts = Array.from({ length: 15 }, (_, i) => `mx${i}.sender.test`);
  const a: Record<string, string[]> = {};
  for (const h of hosts) a[h] = ['203.0.113.1'];
  const resolvers = zone({ txt: { 'sender.test': ['v=spf1 mx -all'] }, mx: { 'sender.test': hosts }, a });

  const result = await checkSpf(SENDER_IP, 'sender.test', resolvers);
  assert.equal(result, 'permerror', `an over-wide MX must be a permerror, got ${result} after ${resolvers.counts.a} address lookups`);
});

test('mechanisms after "all" are ignored, and cost nothing', async () => {
  cites('R-7208-5.1-a');
  // "all" matches everything, so nothing after it is reachable. Evaluating those terms anyway is
  // not merely wasted work: they spend the lookup budget, so a record ending `-all` followed by
  // junk becomes a way to make us do DNS work that cannot affect the result.
  const resolvers = zone({
    txt: { 'sender.test': ['v=spf1 -all include:never.test include:also-never.test exists:nope.test'] },
  });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'fail', 'the "all" decides the result');
  assert.equal(resolvers.counts.txt, 1, `only the record itself was fetched, got ${resolvers.counts.txt}`);
  assert.equal(resolvers.counts.a, 0, 'and nothing after "all" was evaluated');
});

test('a redirect is ignored whenever an "all" is present, whatever the order', async () => {
  cites('R-7208-5.1-b');
  const target = { 'redirected.test': [`v=spf1 ip4:${SENDER_IP} -all`] };

  // The ordinary case: redirect written after the all.
  const after = zone({ txt: { 'sender.test': ['v=spf1 -all redirect=redirected.test'], ...target } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', after), 'fail', 'the redirect is not followed');

  // "Regardless of the relative ordering" — the reason this is a separate requirement. A redirect
  // written BEFORE the all must still be ignored, even though left-to-right evaluation reaches it
  // first. An implementation that only skips terms after "all" follows a redirect its author
  // disabled, and would answer 'pass' here.
  const before = zone({ txt: { 'sender.test': ['v=spf1 redirect=redirected.test -all'], ...target } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', before), 'fail', 'a redirect before the "all" is ignored too');
  assert.equal(before.counts.txt, 1, `and the redirect target is never fetched, got ${before.counts.txt}`);
});

test('a redirect with no "all" in the record IS followed', async () => {
  cites('R-7208-5.1-b');
  // The negative control that stops the case above passing against an implementation that ignores
  // every redirect: with no "all" present, the redirect is the record's answer.
  const resolvers = zone({
    txt: { 'sender.test': ['v=spf1 redirect=redirected.test'], 'redirected.test': [`v=spf1 ip4:${SENDER_IP} -all`] },
  });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'pass');
  assert.equal(resolvers.counts.txt, 2, 'the target was fetched');
});

test('a DNS failure is a temperror, distinct from a record that cannot be evaluated', async () => {
  cites('R-7208-4.6.4-f');
  // The timeout requirement is a floor on patience, and its companion sentence makes exceeding it a
  // temperror. The observable form of the distinction: a resolver that THROWS is transient, while a
  // record over its budget is permanent. Collapsing them either retries forever or treats an outage
  // as a forgery.
  const failing: SpfResolvers = {
    async txt() {
      throw Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' });
    },
    async a() {
      return [];
    },
    async mx() {
      return [];
    },
  };
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', failing), 'temperror');
});

test('the PTR address-lookup cap is not reachable: ptr is not implemented', async () => {
  cites('R-7208-4.6.4-d');
  // RFC 7208 §5.5 deprecates "ptr" and says it SHOULD NOT be published or used; this server does
  // not implement it, so the nested cap on its address lookups has nothing to bound. Registered and
  // cited rather than dropped, with the reason recorded here: a shrinking denominator flatters
  // coverage, and the day ptr is ever implemented this case is already waiting.
  const resolvers = zone({ txt: { 'sender.test': ['v=spf1 ptr -all'] } });
  const result = await checkSpf(SENDER_IP, 'sender.test', resolvers);
  assert.notEqual(result, 'pass', 'an unimplemented mechanism must never authorise a sender');
  assert.equal(resolvers.counts.a, 0, 'and costs no address lookups, so there is nothing to cap');
});
