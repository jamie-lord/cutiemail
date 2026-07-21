# 0010 — Inbound DMARC enforcement: quarantine to Junk, never hard-reject

## Status

Accepted (2026-07-17).

## Context

cutiemail already evaluated inbound DMARC fully — SPF + DKIM + alignment + policy
lookup, now over the real Public Suffix List — but only *recorded* the verdict in an
`Authentication-Results` header and delivered every message to the INBOX regardless. That
looked like a conservative choice; it isn't. cutiemail **is the final delivery point** —
it stores to the mailbox the user reads over IMAP — so there is no downstream filter to
act on the header, and a normal person reading mail in Apple Mail never sees it. A message
that DMARC says is spoofed, whose real owner published "reject anything that fails," was
being handed to the very user the server exists to protect, indistinguishable from genuine
mail. Computing a spoofing verdict and then discarding it is the incomplete-feature smell,
not an opinion. The mission — a modern, correct server a real person receives real mail on
and can trust — requires acting on the verdict.

## Decision

**A message that FAILS DMARC and whose applicable published policy is `p=quarantine` or
`p=reject` is filed into the recipient's Junk folder, not the INBOX.** Specifically:

- **Quarantine, never hard-reject.** Even `p=reject` files to Junk rather than refusing the
  message at SMTP. Two reasons: (1) cutiemail deliberately does not implement ARC (ADR
  0007), and ARC is what rescues legitimately-forwarded mail (mailing lists, `.forward`)
  from DMARC failure — so hard-rejecting *would* bounce real mail. (2) Junk is recoverable;
  a wrong reject is not. Junk is already a provisioned RFC 6154 SPECIAL-USE folder, so it is
  the natural home.
- **`p=none` stays informational.** The owner explicitly asked only to monitor, so a `p=none`
  failure is delivered to the INBOX with the `Authentication-Results` header, unchanged.
- **`pct` is honored.** The record's `pct` gates the share of failures acted on: a failure is
  quarantined only when a sampler draw in `[0,100)` is below `pct` (default `pct=100` → always).
  This is what makes honoring `pct` (a separately-agreed decision) coherent — it only means
  something once there is enforcement to modulate.
- **No `rua`/`ruf` report emission.** Aggregate/failure reports are low-value at a personal
  server's scale and `ruf` is privacy-fraught; out of scope (a separately-agreed decision).

The evaluator (`server/dmarc-inbound.ts`) stays a pure function returning verdict + policy +
pct; the delivery path (`main.ts`) owns the enforcement action.

## Consequences

- The opinion is clean and statable: **quarantine to Junk, never hard-reject, no reports.**
- Enforcing DMARC while ARC is deferred means some legitimately-forwarded mail will land in
  Junk (recoverable, not lost). This raises ARC's value and is the concrete thing that would
  justify un-deferring it later.
- **Scope recorded:** a duplicate-`From` message (the canonical display-spoof) is detected as
  a DMARC fail but currently returns no fetched policy, so it stays in the INBOX with the
  header flag rather than being quarantined. Closing that would mean fetching the first
  From-domain's policy on the multiple-From path; deferred, not silently dropped.
- Only the inbound (port 25) path enforces; authenticated submission (our own users sending)
  is never DMARC-checked.
- Revisitable with a stated reason, like every ADR.
