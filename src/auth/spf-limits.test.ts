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

test('the ten-term limit is cumulative across includes, not per record', async () => {
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

test('an mx mechanism naming more than ten hosts is a permerror', async () => {
  cites('R-7208-4.6.4-c');
  const mxZone = (n: number): CountingResolvers => {
    const hosts = Array.from({ length: n }, (_, i) => `mx${i}.sender.test`);
    const a: Record<string, string[]> = {};
    for (const h of hosts) a[h] = ['203.0.113.1']; // none of them is the sender, so every host is tried
    return zone({ txt: { 'sender.test': ['v=spf1 mx -all'] }, mx: { 'sender.test': hosts }, a });
  };

  const over = mxZone(15);
  const result = await checkSpf(SENDER_IP, 'sender.test', over);
  assert.equal(result, 'permerror', `an over-wide MX must be a permerror, got ${result}`);
  // The refusal must come from the CAP, not from the DNS work: §4.6.4 exists to stop the queries,
  // so discovering the limit after ten of them have gone out spends what it exists to prevent.
  assert.equal(over.counts.a, 0, `and before any address lookup, got ${over.counts.a}`);

  // Exactly ten is within the cap, so the evaluation completes and reaches the final `-all`. This
  // is the half that was previously wrong in the OTHER direction: the ten address lookups were
  // charged to the ten-TERM budget, so a legitimate domain with ten MX hosts and the record
  // `v=spf1 mx -all` was handed a permerror it had not earned. §4.6.4 puts the per-mechanism cap
  // "in addition to" the term limit, not inside it.
  const atCap = mxZone(10);
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', atCap), 'fail', 'ten MX hosts is a conformant record');
  assert.equal(atCap.counts.a, 10, `and all ten are resolved, got ${atCap.counts.a}`);
  assert.equal(atCap.counts.txt, 1, 'costing one term, not eleven');
});

test('a redirect to a domain publishing no SPF record is a permerror, not none', async () => {
  cites('R-7208-6.1-a');
  // §6.1's stated exception, and the structural sibling of the include table below: a redirect
  // whose target publishes nothing is a BROKEN record, not an absent policy. The difference is
  // visible downstream — DMARC reads "none" as "there was no SPF to align against" and "permerror"
  // as "SPF could not be evaluated", and only one of those describes what happened here.
  const dangling = zone({ txt: { 'sender.test': ['v=spf1 redirect=gone.test'] } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', dangling), 'permerror');

  // The negative control: the same record pointing at a target that DOES publish one resolves to
  // whatever that target says, so the case above is refused for the missing record and not for
  // being a redirect.
  const live = zone({ txt: { 'sender.test': ['v=spf1 redirect=live.test'], 'live.test': ['v=spf1 -all'] } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', live), 'fail');
});

test('an include of a domain publishing no SPF record is a permerror', async () => {
  cites('R-7208-5.2-a');
  // The other half of the same table (§5.2: "none | return permerror"). Reading it as "did not
  // match" would let the outer record's `-all` answer fail — a definite verdict derived from a
  // record that could not be evaluated.
  const resolvers = zone({ txt: { 'sender.test': ['v=spf1 include:gone.test -all'] } });
  assert.equal(await checkSpf(SENDER_IP, 'sender.test', resolvers), 'permerror');
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

test('an mx term queries ten address records, not twenty', async () => {
  // RFC 7208 §4.6.4: "the evaluation of each 'MX' record MUST NOT result in querying more than 10
  // address records -- either 'A' or 'AAAA' resource records."  Asking for BOTH types per host
  // makes ten permitted hosts twenty address records, and ten such terms turned one unauthenticated
  // MAIL FROM into ~200 queries aimed at whatever zone the MX targets name — the third-party
  // reflection §11.1 calls the easiest SPF vector to exploit. Only the family the client connected
  // over can match, so the other query cannot change the verdict.
  cites('R-7208-4.6.4-c2');
  const asked: Array<{ name: string; rr: string }> = [];
  const hosts = Array.from({ length: 10 }, (_, i) => `mx${i}.dead.example`);
  const resolvers: SpfResolvers = {
    txt: async (n) => (n === 'one.example' ? ['v=spf1 mx -all'] : []),
    mx: async () => hosts,
    a: async (name, rr) => {
      asked.push({ name, rr });
      return [];
    },
  };
  const result = await checkSpf('198.51.100.7', 'one.example', resolvers);
  assert.equal(result, 'fail');
  assert.equal(asked.length, 10, `ten hosts cost ten address records, got ${asked.length}`);
  assert.ok(asked.every((q) => q.rr === 'A'), 'an IPv4 client is never matched by an AAAA record');
});

test('an IPv6 client asks for AAAA, and only AAAA', async () => {
  const asked: string[] = [];
  const resolvers: SpfResolvers = {
    txt: async () => ['v=spf1 a -all'],
    mx: async () => [],
    a: async (_n, rr) => {
      asked.push(rr);
      return rr === 'AAAA' ? ['2001:db8::1'] : ['198.51.100.1'];
    },
  };
  const result = await checkSpf('2001:db8::1', 'one.example', resolvers);
  assert.equal(result, 'pass');
  assert.deepEqual(asked, ['AAAA']);
});

test('exists is an A lookup even for an IPv6 client, as §5.7 states outright', async () => {
  // "The resulting domain name is used for a DNS A RR lookup (even when the connection type is
  // IPv6)." A name carrying only AAAA records must NOT match.
  cites('R-7208-5.7-a');
  const asked: string[] = [];
  const resolvers: SpfResolvers = {
    txt: async () => ['v=spf1 exists:probe.one.example -all'],
    mx: async () => [],
    a: async (_n, rr) => {
      asked.push(rr);
      return rr === 'AAAA' ? ['2001:db8::1'] : [];
    },
  };
  const result = await checkSpf('2001:db8::1', 'one.example', resolvers);
  assert.deepEqual(asked, ['A'], 'exists asks for A regardless of the connection family');
  assert.equal(result, 'fail', 'an AAAA-only name does not satisfy exists');
});
