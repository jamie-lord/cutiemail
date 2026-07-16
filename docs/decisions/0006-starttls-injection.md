# 0006 — STARTTLS command-injection, and admitting RFC 3207 to the register

## Status

Accepted (2026-07-16).

## Context

The suite's register was, until now, RFC 5321 only: every requirement quoted
`spec/rfc5321.txt` verbatim, ids were `R-5321-…`, and the verbatim gate checked
one file. But the single most consequential *security* conformance defect an
SMTP server can have — the STARTTLS command-injection class (CVE-2011-0411, the
"NO STARTTLS" attack; SEC Consult revisited the family in 2023) — is specified
in RFC 3207 (§4.2), not RFC 5321. A conformance suite that markets itself on
catching the smuggling/injection class (see `docs/research/smtp-divergence.md`)
but structurally *cannot* cite the requirement the attack violates has a real
gap. STARTTLS security was always intended scope; it was deferred only for the
mutant-server infrastructure it seemed to need.

## Decision

1. **Admit RFC 3207 to the register as a second source.** `RequirementDef`
   gains an optional `rfc: 'rfc5321' | 'rfc3207'` (default `rfc5321`). The
   verbatim gate now loads both `spec/rfc5321.txt` and `spec/rfc3207.txt` and
   checks each requirement against its own source — same discipline, no relaxed
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
   reply, so quiet/timeout is the *conformant* outcome — only an actual reply
   convicts. The mutant server models this with an `injectAfterStartTls` defect
   and an `awaitingTls` session state; no cert, no `tls.TLSSocket` server side.

## Consequences / scope left on the table (deliberately)

- **Only the pre-handshake plaintext-injection variant is covered.** Two further
  STARTTLS behaviours need a TLS-*terminating* mutant (a real server-side
  `tls.TLSSocket` handshake), and are deferred as a scoped next-phase piece:
  1. The **smuggle-into-TLS injection variant** — a command replayed *inside* the
     established TLS stream rather than answered in plaintext before it.
  2. The **post-handshake session reset** (RFC 3207 §4.2: "the SMTP protocol is
     reset to the initial state"). A `keepStateAcrossStartTls` defect flag already
     exists for it but cannot be exercised without completing a handshake.

  The design is understood: opt-in `terminateTls` on the mutant, refactor `#handle`
  into an `#attachSession(sock, state, greet)` that re-attaches the data loop to the
  upgraded `tls.TLSSocket` (with reset or, under the defect, retained state), and a
  vendored self-signed test cert. It was deliberately NOT built at the tail of the
  session that built the sink, for three reasons, all "smart engineering over green
  for its own sake":
  - it refactors the mutant's CORE data loop, which every test depends on — high
    blast radius for a one-requirement gain;
  - the self-signed mutant cert forces `rejectUnauthorized:false`, which the clean
    `Conn.startTls()` corpus path does not expose, so the negative control would be
    a bespoke integration test rather than a graded, fixture-gated corpus case (as
    the sink work is) — less clean, and the corpus-path version really wants a
    calibration-time real-cert server anyway;
  - the primary, clearly-defined CVE-2011-0411 variant (pre-handshake plaintext
    injection) IS covered, so this is completeness, not a gap in the core defence.

  The transport's client half already upgrades and flags pre-handshake buffered
  bytes, so the remaining work is the mutant side plus the corpus/integration wiring.
- `EXTRACTED_SECTIONS` lists bare section numbers, so RFC 3207 §4.2 and RFC 5321
  §4.2 share the string "4.2" in the coverage header. Harmless today (the ids
  disambiguate); revisit if a second RFC 3207 section lands.
