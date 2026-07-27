/**
 * RFC 7208 §4 and §4.6.4 — the check_host() evaluation limits — and §5.1 — "all".
 *
 * These are the requirements that make SPF safe to evaluate on an unauthenticated inbound
 * connection. Every mechanism in a sender's record can cost a DNS lookup, the record is published
 * by whoever owns the domain, and the domain in question is chosen by the peer connecting to us —
 * so without the limits below, a hostile sender publishes a record that fans out and every message
 * they send costs us an unbounded number of queries. The "MUST return permerror" half matters as
 * much as the count: a server that quietly stops looking up and returns a NEUTRAL verdict has
 * turned a DoS defence into an authentication bypass.
 *
 * The "all" rules are a different kind of hazard. `all` is a catch-all that matches everything, so
 * a term after it can never be reached — and a redirect that IS reached despite an `all` being
 * present sends the evaluation somewhere the record's author did not intend.
 *
 * Verbatim quotes from spec/rfc7208.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const SPF_LIMITS = [
  {
    id: 'R-7208-4-a',
    rfc: 'rfc7208',
    section: '4',
    page: 14,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Receiving ADMDs that perform this check MUST correctly evaluate the check_host() function as described here.',
    testability: { kind: 'parse' },
    note:
      'The umbrella obligation the rest of this section refines. Registered because it is the thing '
      + 'the corpus as a whole demonstrates: check_host() is an algorithm with a specified result for '
      + 'each input, and "our implementation broadly does this" is not the standard.',
  },
  {
    id: 'R-7208-4.6.4-a',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 17,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SPF implementations MUST limit the total number of those terms to 10 during SPF evaluation, to avoid unreasonable load on the DNS.',
    testability: { kind: 'parse' },
    note:
      'Ten DNS-querying terms per evaluation, counted across the whole recursion — include, a, mx, '
      + 'ptr, exists and redirect. The count is CUMULATIVE, which is the part that is easy to get '
      + 'wrong: a per-record limit lets a chain of includes each spend nine lookups. The attacker '
      + 'controls the record, and the sender chooses when we evaluate it.',
  },
  {
    id: 'R-7208-4.6.4-b',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 17,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If this limit is exceeded, the implementation MUST return "permerror".',
    testability: { kind: 'parse' },
    note:
      'The half that turns the limit from a resource control into a correct one. Stopping the walk '
      + 'and reporting whatever was reached — neutral, or none — lets a sender who publishes a record '
      + 'too large to evaluate escape being judged by it. permerror is a definite answer, and DMARC '
      + 'treats it as a failure to authenticate rather than as an absence of policy.',
  },
  {
    id: 'R-7208-4.6.4-c',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 17,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If this limit is exceeded, the "mx" mechanism MUST produce a "permerror" result.',
    testability: { kind: 'parse' },
    note:
      'A second, nested limit: one "mx" term counts once against the ten, but the MX record it finds '
      + 'may name many hosts, and each needs an address lookup. Ten is the cap on those, and blowing '
      + 'it is a permerror rather than a truncation — contrast the PTR rule below, where the RFC '
      + 'chose the opposite answer.',
  },
  {
    id: 'R-7208-4.6.4-c2',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 18,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text: 'querying more than 10 address records -- either "A" or "AAAA" resource records.',
    testability: { kind: 'parse' },
    note:
      'What the "mx" cap counts, and the half that was missing here. The sentence begins on the '
      + 'previous page ("In addition to that limit, the evaluation of each \'MX\' record MUST NOT '
      + 'result in..."), so only its tail is quoted. The register carried this rule for PTR '
      + '(R-7208-4.6.4-d) and not for MX, which is the mechanism actually implemented. The unit is '
      + 'ADDRESS RECORDS, not hosts: asking each of ten permitted hosts for both A and AAAA is '
      + 'twenty, over a limit of ten. Only the family the client connected over can match, so the '
      + 'server asks for one — which satisfies the cap at ten hosts and refuses no sender that '
      + 'asking for both would have accepted.',
  },
  {
    id: 'R-7208-4.6.4-d',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 18,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'In addition to that limit, the evaluation of each "PTR" record MUST NOT result in querying more than 10 address records -- either "A" or "AAAA" resource records.',
    testability: { kind: 'parse' },
    note:
      'Deliberately different from the MX rule: over-limit PTR results are IGNORED past the first ten '
      + 'rather than producing an error. Registered as its own requirement precisely because the two '
      + 'adjacent limits resolve differently, and an implementation that applies one rule to both is '
      + 'wrong in one direction or the other.',
  },
  {
    id: 'R-7208-4.6.4-e',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 18,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'SPF implementations SHOULD limit "void lookups" to two.',
    testability: { kind: 'parse' },
    note:
      'A void lookup is one returning NXDOMAIN or no answer. Bounding them separately catches the '
      + 'record that stays under ten terms while pointing all of them at names that do not resolve — '
      + 'cheap for the attacker to publish, slow for us to evaluate, and invisible to a count of '
      + 'successful lookups.',
  },
  {
    id: 'R-7208-4.6.4-f',
    rfc: 'rfc7208',
    section: '4.6.4',
    page: 18,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Such a limit SHOULD allow at least 20 seconds.',
    testability: { kind: 'parse' },
    note:
      'A FLOOR on the timeout, not a ceiling: an implementation that gives up after two seconds fails '
      + 'legitimate senders with slow authoritative servers. Paired with the preceding sentence, '
      + 'which asks for a wall-clock limit at all, and the following one, which makes exceeding it a '
      + 'temperror rather than a fail.',
  },
  {
    id: 'R-7208-5.1-a',
    rfc: 'rfc7208',
    section: '5.1',
    page: 21,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Mechanisms listed after "all" MUST be ignored.',
    testability: { kind: 'parse' },
    note:
      '"all" matches everything, so nothing after it is reachable. Evaluating those terms anyway is '
      + 'not merely wasted work: they cost DNS lookups against the limit above, so a record ending '
      + '`-all` followed by junk becomes a way to spend our lookups on terms that can never affect '
      + 'the result.',
  },
  {
    id: 'R-7208-5.1-b',
    rfc: 'rfc7208',
    section: '5.1',
    page: 21,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Any "redirect" modifier (Section 6.1) MUST be ignored when there is an "all" mechanism in the record, regardless of the relative ordering of the terms.',
    testability: { kind: 'parse' },
    note:
      '"Regardless of the relative ordering" is the whole requirement, and the reason it is separate '
      + 'from R-7208-5.1-a: a redirect written BEFORE the "all" must still be ignored, even though the '
      + 'left-to-right rule would otherwise reach it first. An implementation that only skips terms '
      + 'after "all" gets this exactly wrong, and follows a redirect the record\'s author disabled.',
  },
  {
    id: 'R-7208-5.7-a',
    rfc: 'rfc7208',
    section: '5.7',
    page: 25,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'The resulting domain name is used for a DNS A RR lookup (even when the connection type is IPv6).',
    testability: { kind: 'parse' },
    note:
      'Stated in those words, and the parenthesis is the whole point: "exists" is the one mechanism '
      + 'whose record type does NOT follow the connection. A name published with only AAAA records '
      + 'must not satisfy it. Querying both types made an IPv6 client match on an AAAA-only name, '
      + 'which is the opposite of what this says.',
  },
  {
    id: 'R-7208-5.2-a',
    rfc: 'rfc7208',
    section: '5.2',
    page: 22,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'Whether this mechanism matches, does not match, or returns an exception depends on the result of the recursive evaluation of check_host():',
    testability: { kind: 'parse' },
    note:
      'The sentence introduces a table, and the table is the requirement: pass matches; fail, '
      + 'softfail and neutral do not match; temperror returns temperror; and — the row that is easy '
      + 'to lose — permerror and none BOTH return permerror rather than "not match".\n\n'
      + 'Losing that row is not a cosmetic difference in a verdict. It is how the ten-lookup limit '
      + '(R-7208-4.6.4-a) gets escaped: an included record that blows the shared budget returns '
      + 'permerror, and an implementation that reads any non-pass as "not match" carries on '
      + 'evaluating the rest of the outer record. The budget is then advisory rather than enforced, '
      + 'and the sender who published the expensive record escapes being judged by it.',
  },
  {
    id: 'R-7208-6.1-a',
    rfc: 'rfc7208',
    section: '6.1',
    page: 26,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text: 'The result of this new evaluation of check_host() is then considered the result of the current evaluation with the exception that if no SPF record is found, or if the <target-name> is malformed, the result is a "permerror" rather than "none".',
    testability: { kind: 'parse' },
    note:
      'The redirect counterpart of R-7208-5.2-a, registered because the two are the same rule for '
      + 'the two ways one record can defer to another, and an implementation that gets one right '
      + 'and the other wrong is the unmirrored-sibling shape this project keeps finding. The stated '
      + 'exception is the whole content: a redirect to a domain publishing NO SPF record is a broken '
      + 'record, not an absent policy, so it is permerror and not none — and the difference is '
      + 'visible downstream, where DMARC reads "none" as "there was no SPF to align against".',
  },
] as const satisfies readonly RequirementDef[];
