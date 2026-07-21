# 0013 — No HTTP listener: MTA-STS policy generated, hosted externally; autoconfig cut

## Status

Accepted (2026-07-18).

## Context

Two operator-experience features that comparable servers ship (Mox has both)
want an HTTPS responder inside the mail server:

- **Inbound MTA-STS publication** (RFC 8461): without a published policy, mail
  sent *to* this server can be downgraded to plaintext by an active attacker
  (STARTTLS stripping). We *enforce* other domains' policies on our outbound leg
  but offered senders none of our own — a real asymmetry with a real security
  cost.
- **Client autoconfig** (Thunderbird `autoconfig.<domain>`, Microsoft
  autodiscover): removes manual server/port entry at account creation.

Mox bundles a full webserver and justifies it because ACME, MTA-STS, autoconfig,
admin UI, and webmail all need one. None of those other consumers exist here:
cutiemail's ACME is external (certbot), and there is no web UI by design.

## Decision

**cutiemail runs no HTTP listener.** The line "a mail server that also speaks
HTTP" is a genuine scope boundary, and crossing it for two static documents is
not justified when:

1. **The server-derived part of MTA-STS is the policy *content*, not its
   hosting.** The `mx:` line must match the deployment, so `setup` now generates
   the exact policy file and the `_mta-sts` TXT record, with the RFC 8461 §3.1
   `id` derived as a content hash (changes exactly when the policy changes;
   identical re-runs stay diffable). Hosting five static lines is what static
   hosts are for — the file can live on any HTTPS host serving
   `https://mta-sts.<domain>/.well-known/mta-sts.txt`. The generated policy is
   proven to round-trip through our *own* RFC 8461 parser — the code that
   enforces such policies outbound — with a negative control (an unlisted MX is
   refused).
2. **The certificate cost is real and lands on our weakest flank.** A built-in
   responder needs certificate coverage for `mta-sts.<domain>` (and
   `autoconfig.<domain>`), expanding exactly the part of the ops story (cert
   issuance/renewal) that is already external and manual.
3. **Autoconfig's value at this scale is marginal.** The recommended deployment
   uses one name and standard ports (25/587/993), which Thunderbird's and Apple
   Mail's built-in guessing already finds; DEPLOYMENT.md documents the manual
   settings. Cut, not built.

## Revisit triggers

- If built-in ACME is ever justified (it needs an HTTP listener anyway),
  MTA-STS publication and autoconfig ride along at near-zero marginal cost —
  reopen this ADR then.
- Real evidence of a client that fails to find the server without
  autoconfig/SRV records; the cheap first response would be RFC 6186 SRV
  records in `setup`'s output, which need no HTTP at all.
