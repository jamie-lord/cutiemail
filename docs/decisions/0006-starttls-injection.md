# 0006. STARTTLS command-injection, and admitting RFC 3207 to the register

## Status

Accepted (2026-07-16).

## Context

The suite's register was, until now, RFC 5321 only: every requirement quoted
`spec/rfc5321.txt` verbatim, ids were `R-5321-…`, and the verbatim gate checked
one file. But the single most consequential *security* conformance defect an
SMTP server can have, the STARTTLS command-injection class (CVE-2011-0411, the
"NO STARTTLS" attack; SEC Consult revisited the family in 2023), is specified
in RFC 3207 (§4.2), not RFC 5321. A conformance suite that markets itself on
catching the smuggling/injection class (see `docs/research/smtp-divergence.md`)
but structurally *cannot* cite the requirement the attack violates has a real
gap. STARTTLS security was always intended scope; it was deferred only for the
mutant-server infrastructure it seemed to need.

## Decision

1. **Admit RFC 3207 to the register as a second source.** `RequirementDef`
   gains an optional `rfc: 'rfc5321' | 'rfc3207'` (default `rfc5321`). The
   verbatim gate now loads both `spec/rfc5321.txt` and `spec/rfc3207.txt` and
   checks each requirement against its own source: same discipline, no relaxed
   quotes. Ids are `R-3207-<section>-<letter>`. The furniture-stripping in the
   gate was generalised (author-agnostic footer, RFC-agnostic header) so a
   second RFC needs no bespoke filter. Only the requirements we actually test
   are extracted; this is not a full RFC 3207 extraction.

2. **Test the injection without a live TLS handshake.** The classic
   pre-handshake variant is observable on the plaintext channel: send
   `STARTTLS<CRLF>NOOP<CRLF>` in ONE TCP segment, read the 220, then assert the
   server is *silent*. A conformant server discards the buffered `NOOP` (RFC
   3207 §4.2: "the server MUST discard any knowledge obtained from the client …
   not obtained from the TLS negotiation itself") and waits for the ClientHello;
   a vulnerable server answers the injected `NOOP`. The observable is the EXTRA
   reply, so quiet/timeout is the *conformant* outcome. Only an actual reply
   convicts. The mutant server models this with an `injectAfterStartTls` defect
   and an `awaitingTls` session state; no cert, no `tls.TLSSocket` server side.

## Consequences

All three STARTTLS variants are covered, each proven both ways (a conformant server stays
silent; a vulnerable one is convicted by the extra reply) in
`tls-session.integration.test.ts`:

- **Pre-handshake plaintext injection**, the corpus case above: `STARTTLS<CRLF>NOOP<CRLF>`
  in one TCP segment, read the 220, then assert silence. No live TLS handshake needed.
- **Post-handshake session reset** (RFC 3207 §4.2, "the SMTP protocol is reset to the initial
  state"): an opt-in TLS-terminating mutant (`terminateTls`) re-attaches the command loop to
  an upgraded server-side `tls.TLSSocket` (self-signed test cert) with the session state reset
  after the handshake, unless the `keepStateAcrossStartTls` defect retains it. A conformant
  server refuses a post-TLS `MAIL` that lacks a fresh `EHLO` (503); a state-retaining one
  wrongly accepts it (250).
- **Smuggle-into-TLS** (`smuggleIntoTls` defect): plaintext pipelined before the handshake is
  fed into the encrypted session so the injected command would run in the authenticated
  context; a vulnerable server replays the smuggled command inside TLS, a conformant one is
  silent.

One coverage-header wrinkle: `EXTRACTED_SECTIONS` lists bare section numbers, so RFC 3207 §4.2
and RFC 5321 §4.2 share the string "4.2". Harmless today (the ids disambiguate); revisit if a
second RFC 3207 section lands.
