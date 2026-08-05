# 0026. The reserved postmaster mailbox is a floor, not a convention

## Status

Accepted (2026-07-26).

## Context

RFC 5321 §4.5.1 is unusually direct:

> Any system that includes an SMTP server supporting mail relaying or delivery MUST support the
> reserved mailbox "postmaster" as a case-insensitive local name. [...] The requirement to accept
> mail for postmaster implies that RCPT commands that specify a mailbox for postmaster at any of the
> domains for which the SMTP server provides mail service, as well as the special case of
> "RCPT TO:<Postmaster>" (with no domain specification), MUST be supported.

§2.3.5 says the same thing from the other side: the bare form "may be used in a RCPT command without
domain qualification [...] and MUST be accepted if so used".

This server satisfied none of it. `postmaster@<our domain>` resolved only if the operator had
made an account or an alias with that name. The server refused the bare `<postmaster>` outright,
because recipient resolution required an `@`. So a domain-less forward-path could never match.

This gap stayed unnoticed for an embarrassing reason. The conformance corpus has a case for this
since early on, `bare-postmaster-accepted`. The project built and calibrated the suite against
Postfix. But no one ever ran it against the server in the same repository. To ship a conformance
suite and not run it against your own server is to write the exam and not sit it. The gap surfaced
only because the self-update pre-flight (ADR 0025) runs the corpus against a candidate build. That
meant a run against ourselves for the first time.

There is a real design question underneath. Postmaster mail must land *somewhere*, and this project
deliberately has no catch-all (ADR 0009). It insists an address resolves to exactly one account
(ADR 0014). Acceptance of mail we cannot deliver would be backscatter, which is precisely what those
decisions exist to prevent.

## Decision

**`postmaster` resolves to the first enabled account in creation order, as the last step of the
resolution chain.**

The three candidates were:

1. **Require an alias**, which `init` creates. This is explicit and visible in `account alias list`.
   But a MUST that only holds when the operator remembers an extra step is not a MUST. And every
   deployment provisioned before today would stay non-conformant until someone acted.
2. **Auto-create the alias at boot.** This fixes existing deployments, but it claims `postmaster` in
   the shared login/alias namespace. That would make `account add postmaster` impossible afterwards,
   and turn a conformance fix into a permanent restriction on the operator.
3. **A floor under the resolution chain.** Chosen.

The *last* position is the whole point. An account actually named `postmaster` wins. An alias that
points wherever the operator likes wins. `postmaster+tag` subaddressing works. The floor applies only
when nothing else claimed the name. So it adds an answer where there was none, and does not override
anything. And because the server creates no alias row, the name stays free.

Creation order rather than any cleverness: it is stable. It does not move when the operator adds
accounts, and on a single-user deployment there is only one answer anyway. A disabled primary passes
to the next enabled account. So the address survives when an operator disables things.

**The daemon qualifies the bare form once, at its routing chokepoint.** `<postmaster>` becomes
`postmaster@<our domain>` before anything else sees it. So recipient acceptance, local/remote routing,
delivery and the `Received` trace line all handle an ordinary address with no special case. Every
other domain-less forward-path stays exactly as unroutable as it was.

**The server announces this, it is not silent.** The startup banner names the account that postmaster
mail lands in, and says how to route it elsewhere. "The abuse reports go to your inbox" is not
something to discover from the abuse reports.

## Consequences

- The reserved mailbox works on every deployment, including ones provisioned before this existed,
  with no migration and no operator action.
- One well-known address now always accepts mail from unauthenticated senders. That is what the RFC
  requires, and everything downstream is unchanged: SPF, DKIM, DMARC and the Junk filing all apply as
  they do to any other recipient.
- A disabled account named `postmaster` no longer stops postmaster mail — it falls to the floor
  instead. That is a genuine surprise, and it is the price of a guaranteed address. The
  banner is where an operator sees it.
- The same change exposed a defect: the submission port classified a forward-path with no domain as
  *remote*. So an authenticated client could enqueue an undeliverable address for a relay that could
  never succeed. The server now refuses it at RCPT (RFC 5321 §4.1.2 requires a domain outside the
  postmaster exception).
- The corpus now runs against our own inbound listener as part of the test suite. That is the lasting
  fix: this class of gap cannot survive again, and it costs one integration test.

## Consequences for the register

None. The corpus case `bare-postmaster-accepted` (R-5321-2.3.5-g) and
`postmaster-local-part-case-insensitive` (R-5321-4.1.1.3-m) already existed and were already correct.
No one ever ran them against this server.
