# 0007 — A modern, opinionated server: the scope cuts, recorded

## Status

Accepted (2026-07-16).

## Context

The project's north star sharpened: this is not only an SMTP-receiver conformance
suite, it is the test bed for a **whole modern mail server** — one a person can
spin up easily and use with existing clients (Thunderbird, Apple Mail) to send and
receive real mail. TypeScript throughout, SQLite for storage, no large libraries
for the actual mail work, and — the defining principle — **opinionated and
modern**: it deliberately does not support every ancient server or every legacy
spec corner when a cleaner solution is bought by dropping them.

That principle only works if every cut is an *intentional, recorded* decision, not
a silent gap. This ADR records the scope cuts so they are first-class and
revisitable, exactly as the RFC-5321-not-5321bis (0001) and own-runner (0002)
decisions are. The full testing map lives in `docs/TESTING-ROADMAP.md`; this
records the *choices*, with reasons.

## Decision

The server — and therefore the test bed that must cover it — makes these cuts:

1. **No POP3.** IMAP4rev2 serves every modern client. POP3 (RFC 1939) is a whole
   protocol and harness removed for no loss to the target user.
2. **IMAP4rev2 (RFC 9051) only**, plus a curated extension set (IDLE, MOVE,
   CONDSTORE, SPECIAL-USE). The legacy IMAP4rev1 extension long tail is refused.
   This is the single largest scope lever in the project; IMAP's surface is vast
   and most of it serves clients we do not target.
3. **MTA-STS (RFC 8461), not DANE (RFC 7672),** for outbound TLS policy. DANE
   needs a validating DNSSEC stub resolver, which Node does not provide (no TLSA,
   no AD-bit access — see `project_mail_server` memory). MTA-STS achieves the
   same protection over the DNS/HTTPS we *can* do well.
4. **Modern message parsing.** Parse RFC 5322 + MIME strictly for what modern
   mail produces; **reject** rather than heroically repair ancient malformations.
   No source routes, no obscure MIME recovery. Each rejection becomes a
   register-recorded decision, never a silent divergence.
5. **AUTH: SCRAM-SHA-256 + PLAIN-over-TLS only.** No CRAM-MD5, no plaintext AUTH,
   no NTLM/GSSAPI. Modern, secure, small.
6. **ARC (RFC 8617) and Sieve (RFC 5228) deferred** to a later tier. DKIM + SPF +
   DMARC are the deliverability must-haves; ARC matters only for forwarding and
   can follow.
7. **JMAP deferred.** Genuinely modern and desirable, but additive; not part of
   the minimum viable server.

## Consequences

- The test bed is scoped to these cuts: e.g. no POP3 register/corpus is built, the
  IMAP register targets RFC 9051, the TLS harness tests MTA-STS not DANE.
- Each cut is revisitable, but only with a stated reason — the same bar as any
  register `deliberatelyUncovered` decision.
- "Server minimal-first, test suite complete-first" is preserved: the harnesses
  are built ahead of the features, but only for the surface these cuts leave in
  scope. We test comprehensively *within* an intentionally bounded target.
