# 0007. A modern, opinionated server: the scope cuts, recorded

## Status

Accepted (2026-07-16).

## Context

The project's north star sharpened: this is not only an SMTP-receiver conformance
suite, it is the test bed for a **whole modern mail server**, one a person can
start easily and use with existing clients (Thunderbird, Apple Mail) to send and
receive real mail. TypeScript throughout, SQLite for storage, no large libraries
for the actual mail work, and (the defining principle) **opinionated and
modern**: it deliberately drops support for ancient servers and legacy spec
corners where that buys a cleaner solution.

That principle only works if every cut is an *intentional, recorded* decision, not
a silent gap. This ADR records the scope cuts so they are first-class and
revisitable, exactly as the RFC-5321-not-5321bis (0001) and own-runner (0002)
decisions are. The full testing map lives in `docs/TESTING.md`. This ADR
records the *choices*, with reasons.

## Decision

The server (and therefore the test bed that must cover it) makes these cuts:

1. **No POP3.** IMAP4rev2 serves every modern client. POP3 (RFC 1939) is a whole
   protocol and harness that we remove for no loss to the target user.
2. **IMAP4rev2 (RFC 9051) only**, plus a curated extension set (IDLE, MOVE,
   CONDSTORE, SPECIAL-USE). The server refuses the legacy IMAP4rev1 extension long tail.
   This is the single largest scope lever in the project. IMAP's surface is vast,
   and most of it serves clients we do not target.

   > **Amendment (2026-07-17):** the CAPABILITY response now advertises **both**
   > `IMAP4rev1` and `IMAP4rev2` (RFC 9051 §6.1.1 permits both, and real rev2 servers
   > advertise both). This does **not** reverse the scope cut: the server still
   > implements only rev2 semantics. There is no separate rev1 behaviour mode, and the
   > rev1 features rev2 removed (`\Recent`/`RECENT`, `SEARCH RECENT`/`NEW`/`OLD`) stay
   > intentionally unimplemented. The `IMAP4rev1` atom is a **compatibility signal**:
   > some clients and tooling gate the connection on the presence of `IMAP4rev1`/`IMAP4` in
   > CAPABILITY and refuse the server outright without it (verified: Python's `imaplib`
   > raises "server not IMAP4 compliant" against a rev2-only advertisement). rev2 is a
   > near-superset, so those clients then speak a command subset the server serves
   > correctly. Real modern MUAs (Apple Mail, Thunderbird) need no such signal (we drove
   > Apple Mail end-to-end against the rev2-only server before this change), so this
   > widens lower-bound compatibility at no behavioural cost. The residual
   > divergence (a rev1 client that issues a removed `SEARCH` key gets `BAD`, and there is
   > no `\Recent`) is the recorded, accepted gap.
3. **MTA-STS (RFC 8461), not DANE (RFC 7672),** for outbound TLS policy. DANE
   needs a validating DNSSEC stub resolver, which Node does not provide (no TLSA,
   no AD-bit access). MTA-STS achieves the
   same protection over the DNS/HTTPS we *can* do well.
4. **Modern message parsing.** Parse RFC 5322 + MIME strictly for what modern
   mail produces. **Reject** rather than heroically repair ancient malformations.
   No source routes, no obscure MIME recovery. Each rejection becomes a
   register-recorded decision, never a silent divergence.
5. **AUTH: SCRAM-SHA-256 + PLAIN-over-TLS only.** No CRAM-MD5, no plaintext AUTH,
   no NTLM/GSSAPI. Modern, secure, small.
   > **Amendment (2026-08-03):** this conflated two distinct layers, and the code
   > implements only one of them. On the wire the server offers **SASL PLAIN over
   > TLS** and nothing else (`AUTH=PLAIN`, and the server does *not* advertise a
   > `SCRAM-SHA-256` mechanism). SCRAM-SHA-256 is the credential **storage** scheme: the registry
   > holds only `StoredKey`/`ServerKey` and never the password (a negative-controlled
   > test proves it), and the server verifies a PLAIN password against that. So "the password
   > is never persisted" holds. "the password is never *sent*" — SCRAM's on-the-wire
   > property — does **not** hold: with PLAIN, the client sends the cleartext password to the
   > server inside TLS on every login. `AUTH=SCRAM-SHA-256` as a wire mechanism is a
   > reachable future — the code already implements and vector-pins the RFC 5802 proof algebra,
   > and both Thunderbird and Apple Mail advertise it — but is not built. This is a **revisit**
   > item, not a claim the code currently meets.
6. **ARC (RFC 8617) and Sieve (RFC 5228) deferred** to a later tier. DKIM + SPF +
   DMARC are the deliverability must-haves. ARC matters only for forwarding and
   can follow.
   > **Amendment (2026-07-30):** ADR 0011 un-deferred the inbound half of ARC
   > (`server/arc-inbound.ts`, `auth/arc.ts`, `crypto/arc-seal.ts`). Sieve remains deferred.
7. **JMAP deferred.** Genuinely modern and desirable, but additive, not part of
   the minimum viable server.

## Consequences

- These cuts scope the test bed: for example, we build no POP3 register/corpus, the
  IMAP register targets RFC 9051, and the TLS harness tests MTA-STS, not DANE.
- Each cut is revisitable, but only with a stated reason, the same bar as any
  register `deliberatelyUncovered` decision.
- This preserves "Server minimal-first, test suite complete-first": we build the
  harnesses ahead of the features, but only for the surface these cuts leave in
  scope. We test comprehensively *within* an intentionally bounded target.
