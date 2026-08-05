# 0010. Inbound DMARC enforcement: quarantine to Junk, never hard-reject

## Status

Accepted (2026-07-17).

## Context

cutiemail already evaluated inbound DMARC fully (SPF + DKIM + alignment + policy
lookup, now over the real Public Suffix List) but only *recorded* the verdict in an
`Authentication-Results` header and delivered every message to the INBOX regardless. That
looked like a conservative choice. It is not. cutiemail **is the final delivery point**:
it stores to the mailbox the user reads over IMAP, so there is no downstream filter to
act on the header, and a normal person who reads mail in Apple Mail never sees it. A message
that DMARC says is spoofed, whose real owner published "reject anything that fails," reached
the very user the server exists to protect, indistinguishable from genuine
mail. To compute a spoofing verdict and then discard it is the incomplete-feature smell,
not an opinion. The mission (a modern, correct server a real person receives real mail on
and can trust) requires that the server act on the verdict.

## Decision

**The server files a message that FAILS DMARC, and whose applicable published policy is
`p=quarantine` or `p=reject`, into the recipient's Junk folder, not the INBOX.** Specifically:

- **Quarantine, never hard-reject.** Even `p=reject` files to Junk rather than refuse the
  message at SMTP. Two reasons: (1) cutiemail deliberately does not implement ARC (ADR
  0007), and ARC is what rescues legitimately-forwarded mail (mailing lists, `.forward`)
  from DMARC failure, so a hard reject *would* bounce real mail. (2) Junk is recoverable.
  A wrong reject is not. Junk is already a provisioned RFC 6154 SPECIAL-USE folder, so it is
  the natural home.
- **`p=none` stays informational.** The owner explicitly asked only to monitor, so the server
  delivers a `p=none` failure to the INBOX with the `Authentication-Results` header, unchanged.
- **The server honors `pct`, per RFC 7489 §6.6.4.** The record's `pct` gates the share of failures
  the server acts on, via a sampler draw in `[0,100)` (default `pct=100` → always). For
  `p=quarantine`, the server treats the unsampled remainder as no policy, and it reaches the INBOX.
  For `p=reject`, §6.6.4 says to treat the unsampled remainder *as if `p=quarantine`* — not as no
  policy. This server files both reject and quarantine to Junk, so a `p=reject` failure lands in
  Junk **regardless of the sample**: the sampled share is would-be-rejected and the unsampled share
  is quarantined, and both are Junk here. (An earlier reading gated `p=reject` on the sample too,
  which delivered the unsampled spoofed share of a `p=reject` domain to the INBOX — the wrong
  direction.)
- **No `rua`/`ruf` report emission.** Aggregate/failure reports are low-value at a personal
  server's scale and `ruf` is privacy-fraught. Out of scope (a separately-agreed decision).

The evaluator (`server/dmarc-inbound.ts`) stays a pure function that returns the verdict, the
applicable policy, `pct`, and the supporting reporting fields. The delivery path (`main.ts`) owns
the enforcement action.

## Consequences

- The opinion is clean and statable: **quarantine to Junk, never hard-reject, no reports.**
- To enforce DMARC while ARC stays deferred means some legitimately-forwarded mail will land in
  Junk (recoverable, not lost). This raises ARC's value and is the concrete thing that would
  justify un-deferring it later.
- **Multiple-From spoof (closed under ADR 0027, RFC 9989 §11.5):** a message that carries more than
  one author mailbox — several mailboxes in one `From`, or several `From` headers — is a fail. The
  server now evaluates every author domain across all of them and enforces the strictest published
  policy to Junk. When the lookup budget cannot weigh them all, it fails safe to quarantine, so
  the spoof can no longer reach the INBOX when it buries the victim domain past the budget.
- Only the inbound (port 25) path enforces. The server never DMARC-checks authenticated
  submission (our own users who send mail).
- Revisitable with a stated reason, like every ADR.
