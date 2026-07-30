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

This server satisfied none of it. `postmaster@<our domain>` resolved only if the operator happened to
have made an account or an alias with that name, and the bare `<postmaster>` was refused outright —
recipient resolution required an `@`, so a domain-less forward-path could never match.

It went unnoticed for an embarrassing reason. The conformance corpus has had a case for this since
early on, `bare-postmaster-accepted`, and the suite was built and calibrated against Postfix — but it
had never been pointed at the server in the same repository. Shipping a conformance suite and not
running it against your own server is writing the exam and not sitting it. The gap surfaced only
because the self-update pre-flight (ADR 0025) runs the corpus against a candidate build, which meant
running it against ourselves for the first time.

There is a real design question underneath. Postmaster mail has to go *somewhere*, and this project
deliberately has no catch-all (ADR 0009) and insists an address resolves to exactly one account
(ADR 0014). Accepting mail we cannot deliver would be backscatter, which is precisely what those
decisions exist to prevent.

## Decision

**`postmaster` resolves to the first enabled account in creation order, as the last step of the
resolution chain.**

The three candidates were:

1. **Require an alias**, created by `init`. Explicit and visible in `account alias list` — but a MUST
   that only holds when the operator remembered an extra step is not a MUST, and every deployment
   provisioned before today would stay non-conformant until someone acted.
2. **Auto-create the alias at boot.** Fixes existing deployments, but claims `postmaster` in the
   shared login/alias namespace, which would make `account add postmaster` impossible afterwards —
   turning a conformance fix into a permanent restriction on the operator.
3. **A floor under the resolution chain.** Chosen.

Being *last* is the whole point. An account actually named `postmaster` wins; an alias pointing
wherever the operator likes wins; `postmaster+tag` subaddressing works. The floor only applies when
nothing else has claimed the name, so it adds an answer where there was none rather than overriding
anything. And because no alias row is created, the name stays free.

Creation order rather than any cleverness: it is stable, it does not move when accounts are added,
and on a single-user deployment there is only one answer anyway. A disabled primary hands over to the
next enabled account, so the address survives an operator disabling things.

**The bare form is qualified once, at the daemon's routing chokepoint.** `<postmaster>` becomes
`postmaster@<our domain>` before anything else sees it, so recipient acceptance, local/remote routing,
delivery and the `Received` trace line all handle an ordinary address with no special case. Every
other domain-less forward-path stays exactly as unroutable as it was.

**This is announced, not silent.** The startup banner names the account postmaster mail lands in, and
says how to point it elsewhere. "The abuse reports go to your inbox" is not something to discover
from the abuse reports.

## Consequences

- The reserved mailbox works on every deployment, including ones provisioned before this existed,
  with no migration and no operator action.
- One well-known address now always accepts mail from unauthenticated senders. That is what the RFC
  requires, and everything downstream is unchanged: SPF, DKIM, DMARC and the Junk filing all apply as
  they do to any other recipient.
- A disabled account named `postmaster` no longer stops postmaster mail — it falls to the floor
  instead. That is a genuine surprise, and it is the price of the address being guaranteed. The
  banner is where an operator sees it.
- A defect fell out of the same change: a forward-path with no domain was classified as *remote* on
  the submission port, so an authenticated client could get an undeliverable address enqueued for a
  relay that could never succeed. It is now refused at RCPT (RFC 5321 §4.1.2 requires a domain
  outside the postmaster exception).
- The corpus now runs against our own inbound listener as part of the test suite. That is the lasting
  fix: this class of gap cannot survive again, and it costs one integration test.

## Consequences for the register

None. The corpus case `bare-postmaster-accepted` (R-5321-2.3.5-g) and
`postmaster-local-part-case-insensitive` (R-5321-4.1.1.3-m) already existed and were already correct.
They were simply never run against this server.
