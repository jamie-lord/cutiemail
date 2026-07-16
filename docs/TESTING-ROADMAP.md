# Testing roadmap — from an SMTP-receiver suite to a whole-server test bed

This project builds a **modern, opinionated "SQLite of email"** — a heavily-tested mail server
in TypeScript that a person can spin up easily and use with existing clients (Thunderbird, Apple
Mail) to **send and receive** real mail. The design ethos (see also `docs/decisions/`):

- **TypeScript throughout; no large libraries for the actual mail work.** Protocol, parsing and
  crypto are hand-built on the byte layer — *bytes, never strings*.
- **SQLite for all storage.** Mailboxes, messages, IMAP state, the outbound queue, accounts.
- **Opinionated and modern.** We deliberately choose which spec corners to honour when it buys a
  cleaner solution, and we do **not** support every ancient server. Every such cut is a recorded
  decision (`§ Opinionated cuts` below), never blind omission.
- **Server minimal-first; test suite complete-first.** The server grows feature by feature
  through clean architecture. The *test bed* is built ahead of it — the SMTP-receiver suite
  existed before the server does. This document is the map of the rest.

## How the server actually works (why each harness exists)

A server Thunderbird can fully use plays four network roles plus a deliverability layer:

```
Thunderbird ─submission(587)─▶ US ─delivery, we are the CLIENT(25)─▶ recipient MX
recipient   ─inbound(25)──────▶ US ─store─▶ IMAP(993) ─▶ Thunderbird reads
```

Thunderbird never talks SMTP to the world; it submits to us, and *we* relay outward as an SMTP
**client**. Reading mail is a different protocol entirely (IMAP). Every arrow, plus the message
bytes that flow along them and the auth that protects them, needs a test harness.

## The testing pattern (proven on the SMTP-receiver suite)

Each surface reuses the same spine that worked for RFC 5321:

1. **Requirement register** — every normative statement, verbatim-quoted, gated by a test that
   checks each quote against the vendored spec; tagged with RFC-2119 level and the bound party.
2. **Corpus** — test cases, each citing a RequirementId (compile-time traceable).
3. **Negative controls** — a defect model (mutant server / mutated input) proving each test
   *detects* its violation, not just passes. Coverage counts a test with no negative control as
   half-covered.
4. **Four-state outcome** — conformant / non-conformant / permitted-latitude / inconclusive.
5. **Calibration** — run against real independent implementations, triage every disagreement.

Two adapter shapes recur: a **network adapter** (drive a server over a socket — SMTP, IMAP) and
a **library adapter** (feed inputs to an in-process parser/engine — MIME, DKIM, address parsing).
The library-adapter areas define a thin interface the future implementation must satisfy, so the
corpus is server-agnostic and can exist before the code does.

---

## The map

Legend: **[have]** built · **[build]** must author · **[adopt]** vendor an existing suite ·
**[extend]** grows the existing SMTP suite.

### Tier 0 — done

| # | Area | Spec | Harness | Status |
|---|---|---|---|---|
| 1 | SMTP receiver conformance | RFC 5321 | network; register+corpus+mutant+calibration | **[have]** — calibrated vs Exim/mox/aiosmtpd, zero false positives |

### Tier 1 — the critical path to a working Thunderbird round-trip

| # | Area | Spec | Harness | Notes / opinionated lever |
|---|---|---|---|---|
| 2 | Submission + AUTH | RFC 6409, 4954, SCRAM 5802 | **[building]** SCRAM proof crypto landed (`src/auth/scram.ts`); message exchange + submission fix-up to come | AUTH mechanisms, STARTTLS-before-AUTH, submission fix-up (Date/Message-ID). **SCRAM proof crypto + message exchange landed:** the password-never-sent proof algebra (PBKDF2 → ClientProof/ServerSignature, server-side verify, pinned to the RFC 5802 §5 vectors, SHA-1 + SHA-256), AND the client-first/server-first/client-final message parsing with the nonce-continuation checks (client verifies the server nonce continues its own; server verifies the echoed nonce) that prevent splice/replay — each negative-controlled. **AUTH state machine landed** (`src/smtp/auth-state.ts`, RFC 4954 §4): AUTH-not-during-transaction, no-re-auth, and the opinionated no-plaintext-AUTH-without-TLS gate (ADR 0007), each negative-controlled. Still to build: SASLprep, the server-final message, wiring the state machine to a live submission server. *Lever: SCRAM-SHA-256 + PLAIN-over-TLS only; refuse plaintext AUTH.* |
| 3 | Outbound SMTP client / delivery | RFC 5321 (client half), 3464 (DSN) | **[building]** reference delivery client + scriptable peer (`src/client/`, `src/testing/client-peer.ts`); DNS mock + queue tests to come | The sending leg. **Send-path core landed (ADR 0008):** a reference delivery client with switchable defects, driven against a scriptable peer, makes the client-binding requirements testable — 6 reclassified `not-testable`→`wire-client` so far (EHLO-preferred, HELO-fallback, CRLF-only, lock-step, terminating-dot, no-data-after-5yz), each negative-controlled. Still to build on this base: MX lookup, retry/backoff, bounce/DSN generation, crash recovery, 8BITMIME negotiation, timeouts. |
| 4 | IMAP server | RFC 9051 (IMAP4rev2) | **[building]** reference response parser (`src/imap/response.ts`, `src/register/imap/`); Dovecot `imaptest` adoption + command/state coverage to come | The read leg. **Both wire directions landed:** a reference response-line parser (tagged/untagged/continuation dispatch, the five status conditions, always-untagged PREAUTH/BYE, bracketed response codes) AND a command-line parser (strict spacing, tag/command/args, reserved-tag rejection, tag-reuse acceptance), and literal detection (synchronizing `{n}` vs non-synchronizing `{n+}`), each negative-controlled. Still to build: literal octet-reading + re-parse, mailbox state (SELECT/FETCH/SEARCH/STORE), and the curated extensions. *Lever (largest in the project): IMAP4rev2 + a curated few extensions (IDLE, MOVE, CONDSTORE, SPECIAL-USE); refuse the legacy long tail.* |
| 5 | Message format: RFC 5322 + MIME | RFC 5322, 2045-2049, 2047, 6532 | **[building]** reference parsers with switchable defects (`src/message/`) + **[adopt]** torture corpora to come | Foundational — every surface touches it. **Landed:** RFC 5322 §2.1/§2.2/§3.3/§3.4.1/§3.6 (structure, header-injection defence, date-time, addr-spec, field validation) RFC 2045 §4/§5/§6 (MIME-Version, Content-Type, Content-Transfer-Encoding — the MIME-confusion surface), RFC 2046 §5.1.1 (multipart boundary splitting — the boundary-confusion surface), and RFC 2047 §2/§5/§6.2 (encoded-word decoding — the header-confusion surface), each negative-controlled. Still to build: recursive part-header parsing / nested multipart, EAI/UTF-8 (6532), the torture corpora. *Lever: parse modern strictly; reject rather than heroically repair, each rejection recorded.* |
| 5a | Address parsing | RFC 5321 §4.1.2, RFC 5322 §3.4 | **[adopt]** `isemail` corpus + **[build]** | The "email address parsing is impossible" surface. *Lever: accept the RFC-5321 mailbox grammar; reject the RFC-5322 exotica (comments, folding, quoted exotica) modern mail never uses.* |

### Tier 2 — deliverability (so mail isn't silently junked)

| # | Area | Spec | Harness | Notes |
|---|---|---|---|---|
| 6 | SPF | RFC 7208 | **[building]** reference record parser + evaluator (`src/auth/spf.ts`, `src/register/auth/`); openSPF YAML suite (~200 cases) to adopt | Inbound sender check. **Foundation landed:** parse `v=spf1` records into ordered terms + evaluate with an injected match decision (no DNS yet), covering the version gate, left-to-right first-match, and qualifier semantics — each negative-controlled. Still to build: DNS resolution, macro expansion, the 10-lookup limit, `redirect`/`exp` modifiers, and the openSPF vector adoption. |
| 7 | DKIM | RFC 6376 | **[building]** verify path complete end-to-end (`src/crypto/dkim-*.ts`, `src/register/crypto/`); Ed25519 + signing direction to come | Sign outbound, verify inbound. **DKIM verify path complete end-to-end:** the four simple/relaxed canon algorithms (pinned to the RFC 6376 §3.4.5 vectors), the §3.5 tag-list parser (duplicate/required/unknown tags), the §3.7 body hash (real SHA-256 over the canon body vs `bh=`), and the §3.7-step-2 header hash + **RSA signature verification**, the §5 **signing (outbound) direction** — a signed message ROUND-TRIPS through the verifier — and **Ed25519** (RFC 8463), pinned to the §A vector (the public key derived from the published secret key equals the published one) with its own sign/verify round-trip — the `l=` body-length limit (with the §8.2 append-attack made visible), and the §3.6.1 **public-key record parser** (version discard + revocation, wired end-to-end: the key parsed from an RFC 8463 §A.2 record verifies a real Ed25519 signature) — all real `node:crypto`, all negative-controlled. Still to build: `x=` signature expiry and DNS record *retrieval* (the parse is done). |
| 8 | DMARC | RFC 7489 | **[building]** reference record parser + alignment check (`src/auth/dmarc.ts`); policy-tree eval + PSL to come | Policy + SPF/DKIM **alignment**. **Foundation landed:** parse `v=DMARC1` records (required/ordered tags, unknown-tag tolerance, policy/mode extraction) + strict-vs-relaxed identifier alignment (Organizational Domain injected), each negative-controlled. Still to build: DNS record discovery, the Public Suffix List for real org-domain, `pct`/`sp` policy application, and report (`rua`/`ruf`) handling. |
| 9 | ARC | RFC 8617 | **[building]** chain-structure validator (`src/auth/arc.ts`); AMS/AS signature verify + ValiMail `arc_test_suite` to come | Survives forwarding. **Chain structure landed:** continuous 1..N instances + consistent `cv` (i=1 none, i>1 pass, never fail), each negative-controlled. Still to build: the AMS/AS signature verification (reuses the DKIM machinery over ARC canonicalization). *Lever: **deferrable** — DKIM+SPF+DMARC are the must-haves.* |

### Tier 3 — cross-cutting foundations (build alongside, test hard)

| # | Area | Spec | Harness | Notes / opinionated lever |
|---|---|---|---|---|
| 10 | TLS / transport security | RFC 3207, 8314, 8461, 7672 | **[building]** MTA-STS policy parser + MX matcher (`src/transport/mta-sts.ts`, `src/register/transport/`); STARTTLS (RFC 3207) already in the SMTP register; negotiation/downgrade tests to come | STARTTLS both ways, implicit TLS, cert lifecycle. **MTA-STS landed:** policy parse (version/mode gates) + the security-critical MX wildcard matcher (one left-most label only, RFC 8461 §4.1 examples), each negative-controlled. Still to build: policy fetch/caching, TLS-RPT, certificate validation, STARTTLS downgrade-resistance tests. *Lever: **MTA-STS over DANE** — DANE needs DNSSEC validation Node does not provide.* |
| 11 | Storage (SQLite) | RFC 9051 §2.3.1.1 | **[building]** reference mailbox model with UID semantics (`src/store/mailbox.ts`); SQLite backing + crash-recovery to come | Schema, crash consistency, concurrency, **IMAP UID monotonicity**, transaction integrity. **Semantics landed:** a reference in-memory mailbox pins the UID invariants (strictly ascending assignment, never-reused across expunge, monotonic UIDNEXT), each negative-controlled — the SQLite layer, when built, must reproduce this. Still to build: the SQLite schema/DAL, crash consistency, concurrency, UIDVALIDITY-change semantics, quotas. |
| 12 | Queue / spool | RFC 5321 §4.5.4, 3464 | **[building]** reference queue with retry semantics (`src/store/queue.ts`); SQLite persistence + DSN + recovery to come | Persistence, retry scheduling, dead-letter, bounce, recovery-after-kill. Overlaps #3. **Retry semantics landed:** a reference queue (injected time) covering queue-and-retry, delayed backoff, permanent-bounce-not-retry, and the give-up window — each negative-controlled, citing the §4.5.4.1 client requirements the receiver suite can't observe. Still to build: SQLite persistence, crash-recovery, dead-letter. **DSN generation (RFC 3464) landed** separately (`src/message/dsn.ts`): message/delivery-status generate + validate (Final-Recipient + Action required, valid action-values), round-tripped and negative-controlled — the body the queue emits on bounce. |
| 13 | Accounts / auth backend | SCRAM, argon2 | **[build]** | Password hashing, SCRAM state, brute-force lockout. |
| 14 | Fuzzing | — | **[build]** fuzz harness + corpora | The parsers (SMTP, MIME, IMAP, address) are the attack surface. Highest security ROI/hour. |
| 15 | End-to-end / interop / differential | — | **[build]** (started) | Full round-trip between two instances + a real MUA; differential vs real servers (begun: Exim/mox). |

## Opinionated cuts (recorded decisions — revisit only with a reason)

- **No POP3.** IMAP4rev2 serves every modern client; POP3 is a whole protocol + harness removed.
- **IMAP4rev2 only**, plus a curated extension set. The legacy IMAP extension long tail is refused.
- **MTA-STS, not DANE**, for outbound TLS policy (DNSSEC/DANE is impractical on Node).
- **Modern message parsing**: reject rather than repair ancient malformations; no source routes,
  no obscure MIME recovery. Each rejection is a register-recorded decision, not silent.
- **AUTH: SCRAM-SHA-256 + PLAIN-over-TLS only.** No CRAM-MD5, no plaintext AUTH, no NTLM.
- **ARC and Sieve deferred** to a later tier, not the minimum viable server.
- **JMAP** is a desirable later addition, not part of the minimum.

## Sequencing

- **Critical path to a demo round-trip:** Tier 1 (#2–#5) + minimal #10 (TLS) + minimal #11
  (storage). The smallest thing Thunderbird can send *and* read through.
- **Then deliverability** (Tier 2) so it works against Gmail/Outlook, not just itself.
- **Foundations** (Tier 3) grow underneath throughout.
- Harnesses are built **ahead of or alongside** their feature: the test bed leads, the server
  fills it in. "Test suite complete" and "server minimal" are not in tension.
