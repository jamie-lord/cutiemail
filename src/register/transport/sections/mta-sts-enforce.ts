/**
 * RFC 8461 §3.1, §4.2 and §5 — the MTA-STS rules that decide whether outbound mail is protected.
 *
 * MTA-STS is the only thing standing between opportunistic STARTTLS and an on-path attacker, and it
 * works by being strict: a recipient domain publishes "enforce" and the sending MTA then MUST NOT
 * deliver to a host that fails MX matching, fails certificate validation, or does not offer
 * STARTTLS. Every one of those is a refusal to send, which makes this an unusual security surface —
 * the failure mode of getting it wrong is that mail goes out anyway, in the clear, and nothing
 * looks broken.
 *
 * ADR 0007 chose MTA-STS over DANE because DANE needs a validating DNSSEC stub resolver Node does
 * not provide. That makes these requirements the whole of this server's outbound TLS policy rather
 * than one layer of two, and worth pinning individually.
 *
 * The §5 retry rule is the one most easily missed: a policy failure MUST NOT become a permanent
 * bounce before re-checking DNS for an updated policy. A domain that rotates its policy would
 * otherwise have every sender permanently reject its mail for as long as their cache is stale.
 *
 * Verbatim quotes from spec/rfc8461.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const MTA_STS_ENFORCE = [
  {
    id: 'R-8461-3.1-a',
    rfc: 'rfc8461',
    section: '3.1',
    page: 6,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The TXT record MUST begin with the sts-version field; the order of other fields is not significant.',
    testability: { kind: 'parse' },
    note:
      'A positional requirement in an otherwise order-free record, which is exactly the kind of rule '
      + 'a tolerant parser quietly drops. Accepting `id=x; v=STSv1` would mean honouring a record the '
      + 'spec says to disregard — and since the record is what turns MTA-STS on, being generous here '
      + 'means enabling enforcement on the strength of something malformed.',
  },
  {
    id: 'R-8461-3.1-b',
    rfc: 'rfc8461',
    section: '3.1',
    page: 6,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'This string MUST uniquely identify a given instance of a policy, such that senders can determine when the policy has been updated by comparing to the "id" of a previously seen policy.',
    testability: { kind: 'parse' },
    note:
      'The "id" is the cache key: a sender re-fetches the policy when it changes and not otherwise. '
      + 'A sender that ignores it either never notices an update — which is what the §5 retry rule '
      + 'exists to bound — or re-fetches on every message, which is a self-inflicted load problem.',
  },
  {
    id: 'R-8461-3.1-c',
    rfc: 'rfc8461',
    section: '3.1',
    page: 7,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'If the resulting TXT record contains multiple strings, then the record MUST be treated as if those strings are concatenated without adding spaces.',
    testability: { kind: 'parse' },
    note:
      'DNS splits TXT records over 255-octet strings, so a real policy record arrives in pieces. '
      + '"Without adding spaces" is the operative half: joining with a space corrupts whichever field '
      + 'straddles the split, and the record then fails to parse — turning enforcement silently off '
      + 'for exactly the domains whose records are long enough to be split. The join lived inline in '
      + 'main.ts\'s DNS adapter (a private const) and so was recorded uncovered; it is now the exported '
      + '`joinTxtRecord` (src/wire/dns-txt.ts), shared by the SPF and DKIM TXT paths that carry the '
      + 'same rule, and pinned in dns-txt.test.ts with the space-joined form as the negative control.',
  },
  {
    id: 'R-8461-3.2-c',
    rfc: 'rfc8461',
    section: '3.2',
    page: 8,
    level: 'REQUIRED',
    party: 'client',
    normativeSource: 'prose',
    text: 'sts-policy-max-age / ; required once',
    testability: { kind: 'parse' },
    note:
      'Quoted from the policy ABNF, where the requirement lives: §3.2 describes max_age in prose '
      + 'without an RFC 2119 keyword, and the grammar is what makes it mandatory. A policy with no '
      + 'max_age has no defined lifetime, so a sender either caches it forever — pinning a domain to '
      + 'a policy it has since replaced — or not at all, re-fetching on every message. Neither is a '
      + 'reading the spec offers, which is why the field is not optional.',
  },
  {
    id: 'R-8461-4.2-a',
    rfc: 'rfc8461',
    section: '4.2',
    page: 12,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The certificate presented by the receiving MTA MUST not be expired and MUST chain to a root CA that is trusted by the Sending MTA.',
    testability: { kind: 'not-testable', reason: 'Certificate chain validation is performed by Node\'s TLS stack against the system trust store; observing it would test Node rather than this project.' },
    note:
      'Delegated deliberately. What this project owns is that validation is ENABLED on the enforced '
      + 'path — that `rejectUnauthorized` is not turned off — rather than the chain-building itself. '
      + 'Registered so the delegation is a recorded decision rather than an absence.',
  },
  {
    id: 'R-8461-4.2-b',
    rfc: 'rfc8461',
    section: '4.2',
    page: 12,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text: 'The certificate MUST have a subject alternative name (SAN) [RFC5280] with a DNS-ID [RFC6125] matching the hostname, per the rules given in [RFC6125].',
    testability: { kind: 'parse' },
    note:
      'The hostname checked is the MX host, not the recipient domain — the distinction MTA-STS turns '
      + 'on. A sender that validates the chain but skips the name check accepts any certificate from '
      + 'any CA-trusted host, which is precisely the attacker\'s position in the scenario MTA-STS '
      + 'exists to prevent.',
  },
  {
    id: 'R-8461-5-a',
    rfc: 'rfc8461',
    section: '5',
    page: 12,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: '"enforce": In this mode, Sending MTAs MUST NOT deliver the message to hosts that fail MX matching or certificate validation or that do not support STARTTLS.',
    testability: { kind: 'parse' },
    note:
      'Three independent refusals in one sentence, and each must hold alone: an MX not matching the '
      + 'policy, a certificate that does not validate, and a host offering no STARTTLS. The failure '
      + 'mode is silent — mail goes out in the clear and everything looks normal — so each is worth '
      + 'its own case rather than one representative.',
  },
  {
    id: 'R-8461-5-b',
    rfc: 'rfc8461',
    section: '5',
    page: 13,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text: 'When a message fails to deliver due to an "enforce" policy, a compliant MTA MUST NOT permanently fail to deliver messages before checking, via DNS, for the presence of an updated policy at the Policy Domain.',
    testability: { kind: 'parse' },
    note:
      'The rule that keeps a strict policy from being a trap. A domain rotating its MX set updates '
      + 'its policy, and senders holding a stale cached copy would otherwise permanently bounce its '
      + 'mail until the cache expired. Re-checking DNS before giving up is what makes long policy '
      + 'lifetimes safe to publish.',
  },
  {
    id: 'R-8461-5-c',
    rfc: 'rfc8461',
    section: '5',
    page: 13,
    level: 'SHOULD',
    party: 'client',
    normativeSource: 'keyword',
    text: '(In all cases, MTAs SHOULD treat such failures as transient errors and retry delivery later.)',
    testability: { kind: 'parse' },
    note:
      'The companion to R-8461-5-b, and the reason a policy failure belongs in the retry queue rather '
      + 'than the dead-letter table. Transient is the safe reading: a permanent bounce discards mail '
      + 'over what may be a temporary disagreement about a policy.',
  },
] as const satisfies readonly RequirementDef[];
