# How it's tested — and why that's trustworthy

Correctness is the point of this project, so the test bed is not an afterthought — for most of
the surfaces below it was built *before* the code it now verifies, and the server grew to fill
it in. Two disciplines run through everything:

- **Every conformance check is proven to detect its own violation.** Each check runs both ways:
  it must pass against a clean implementation *and* fail against one with exactly the defect it
  targets. A test never shown to fail is counted as half-covered, not covered.
- **Every claim traces to the spec.** Normative statements are quoted verbatim in a
  [requirement register](../src/register/) — a test checks each quote against the vendored RFC
  text — tagged with the RFC 2119 level and the party it binds.

## The four roles a mail server plays

A server Thunderbird can fully use plays four network roles, plus a deliverability layer, and
each arrow needs its own harness:

```mermaid
flowchart LR
    TB["Thunderbird"]
    US["cutiemail"]
    MX["recipient MX"]
    SENDER["another sender"]

    TB -->|"submission · 587"| US
    US -->|"delivery, as SMTP client · 25"| MX
    SENDER -->|"inbound · 25"| US
    US -->|"store, then IMAP · 993"| TB
```

A mail client never talks SMTP to the world; it submits to its own server, which relays outward
as an SMTP **client**. Reading mail back is a different protocol entirely. The message bytes
that flow along the arrows, and the authentication that protects them, are surfaces of their
own.

## The pattern every surface follows

1. **Requirement register** — the spec's normative statements, verbatim, machine-checked
   against the vendored RFC.
2. **Corpus** — test cases, each citing a requirement ID (compile-time traceable).
3. **Negative controls** — a defect model (a mutant server, or mutated input) proving each test
   *detects* its violation.
4. **Four-state outcomes** — conformant / non-conformant / *permitted-latitude* / inconclusive.
   Most of RFC 5321 is SHOULD/MAY; a declined SHOULD is recorded latitude, not a failure, and
   only a violated MUST is a finding.
5. **Calibration** — run against real independent implementations, with every disagreement
   triaged to *our bug*, *our misreading*, or *a genuine divergence*.

Two adapter shapes recur: a **network adapter** (drive a server over a real socket — SMTP,
IMAP) and a **library adapter** (feed inputs to an in-process parser or engine — MIME, DKIM,
address parsing). The library-adapter corpora are server-agnostic, which is what allowed them
to exist before the server did.

## The map, surface by surface

### SMTP receiver — RFC 5321

The deepest harness: a full socket-driven conformance suite with a mutant server for negative
controls, **calibrated against Exim, mox, and aiosmtpd with zero false positives** (the
divergences that surfaced — all three honour bare-LF command terminators, a widely-relaxed
MUST NOT — are triaged and recorded in [`reference-servers/`](../reference-servers/)). The
flagship coverage is the CRLF/SMTP-smuggling corpus and the RFC 3207 STARTTLS
session-security class — pre-handshake injection, smuggle-into-TLS, post-handshake reset. This
suite doubles as a standalone tool you can point at any MTA:
[IMPLEMENTING-A-CONFORMANT-SERVER.md](IMPLEMENTING-A-CONFORMANT-SERVER.md).

### Submission and authentication — RFC 6409, 4954, 5802

The SCRAM proof algebra (PBKDF2 → ClientProof/ServerSignature) is pinned to the RFC 5802 §5
test vectors, for both SHA-1 and SHA-256; the message exchange enforces the nonce-continuation
checks that prevent splice and replay. The AUTH state machine covers no-AUTH-mid-transaction,
no re-auth, and the deliberate no-plaintext-AUTH-without-TLS gate. Submission fix-up (missing
`Date`/`Message-ID`/`From`) is tested per RFC 6409, and **sender authorization** — an account
may only send as an address it owns — carries its own spoof-attempt corpus (ADR 0015).

### Outbound delivery — RFC 5321 (client half), 3464

Client-side requirements are unobservable from a receiver socket, so the harness inverts: a
reference delivery client with **switchable defects** is driven against a scriptable peer,
making the client-binding requirements (EHLO-preferred, HELO fallback, CRLF-only, lock-step
dialogue, terminating dot, no-data-after-rejection) testable and negative-controlled. On top of
that sit integration proofs for the real relay: MX resolution order, the persistent retry queue
surviving a kill mid-retry, opportunistic STARTTLS with downgrade rules, null-MX permanent
bounce, and full `multipart/report` DSN generation. The end-to-end proof is live: the reference
deployment exchanges authenticated mail with Gmail, SPF/DKIM/DMARC all passing.

### IMAP — RFC 9051

Both wire directions are parsed by tested reference parsers (response dispatch, command
grammar, synchronizing and non-synchronizing literals), and the full mailbox model —
UIDs, UIDVALIDITY, flags, EXPUNGE, sequence numbers, read-only sessions — is pinned by an
invariant suite. The server is **calibrated against Dovecot's `imaptest`**, which found a real
RFC 9051 §7.4.1 violation on its first run (sequence numbers renumbered across connections
before the client saw the EXPUNGE) — fixed, then re-verified clean across ~12,000 mutations
with five concurrent clients ([`reference-servers/CALIBRATION-imaptest.md`](../reference-servers/CALIBRATION-imaptest.md)).
Multi-connection sync, CONDSTORE/QRESYNC semantics, and connection teardown each carry their
own regression suites.

### Message format — RFC 5322 + MIME (2045–2047)

Structure and header parsing, header-injection defence, date-time, addr-spec, MIME-Version /
Content-Type / Content-Transfer-Encoding (the MIME-confusion surface), multipart boundary
splitting (the boundary-confusion surface), and RFC 2047 encoded words (the header-confusion
surface) — each negative-controlled. A **torture corpus** of ~34 real-world-shaped hostile
messages (deeply nested multiparts, malformed boundaries, 8-bit headers, bare CR/LF, empty
parts) runs through the live parse and the ENVELOPE/BODYSTRUCTURE serializers, asserting a
defined outcome for every message: it parses, or it is cleanly rejected — never a crash, never
malformed IMAP output. The fixtures are byte-exact derived equivalents (the famous historical
corpora have unclear licensing), each documenting the failure mode it models.

### Address parsing — RFC 5321 §4.1.2, RFC 5322 §3.4

The "email address parsing is impossible" surface is pinned by the
[dominicsayers/isemail](https://github.com/dominicsayers/isemail) corpus — 164 cases,
partitioned as an oracle: every `ISEMAIL_ERR` case rejected, every deliverable form accepted,
and the obsolete tail (comments, folding, `obs-*` grammar) deliberately rejected as a recorded
scope decision.

### SPF — RFC 7208

Record parsing into ordered terms, left-to-right first-match evaluation, qualifier semantics,
recursive `a`/`mx`/`include`/`redirect` resolution over DNS, IPv4/IPv6 (and mapped-IPv6) CIDR
matching, and the §4.6.4 ten-lookup limit. Macros are a deliberate safe non-match — never a
false pass.

### DKIM — RFC 6376, 8463

All four canonicalization algorithms pinned to the RFC 6376 §3.4.5 vectors; the tag-list
parser; the body hash against `bh=`; RSA and Ed25519 signature verification *and* signing, each
pinned to published RFC vectors and proven by round-trip; the `l=` body-length limit with the
§8.2 append attack made visible; the public-key record parser including revocation. On the send
path **`From` is oversigned** (listed in `h=` once more than it appears) so a prepended-`From`
replay breaks the signature — with a reproduce-first attack test — and signer and verifier
share one RFC 6376 §5.4.2 header selector, the same code ARC uses.

### DMARC — RFC 7489

Record parsing, strict and relaxed alignment, organizational-domain derivation via a fully
embedded Public Suffix List (it passes the canonical publicsuffix.org test suite), the §6.6.3
fallback, and `sp=` for subdomains. Enforcement is tested end to end: a `p=quarantine` /
`p=reject` failure is filed to Junk — never hard-rejected, so forwarded mail is not lost —
with `pct` honoured (ADR 0010).

### ARC — RFC 8617

The full §5.2 validator: chain structure, the newest AMS over body and headers, and every seal
back to the first, RSA and Ed25519, producing `cv=` with all failures permanent. The seal
signing input is pinned by a golden-bytes test independent of the sign/verify round-trip. The
one behavioural consumer — a **trusted-sealer override** that rescues a DMARC-failed but
validly-ARC-sealed message from a forwarder you explicitly trust — is integration-tested in
the daemon: trusted chains reach the inbox, untrusted and tampered chains stay in Junk
(ADR 0011).

### Transport security — RFC 3207, 8461

STARTTLS with the command-injection defence in both directions (the pre-handshake plaintext
buffer is discarded), and MTA-STS end to end: policy parsing, the security-critical one-label
wildcard MX matcher (the RFC 8461 §4.1 examples), HTTPS policy fetch with per-id caching, and
enforce-mode delivery restricted to a policy-listed MX over a validated certificate — never a
plaintext downgrade.

### Storage — SQLite

The semantics are pinned twice. A reference in-memory mailbox carries the invariant suite; the
real `node:sqlite`-backed store is then validated **differentially** — one exercise sequence
runs against both implementations and the results must be identical, so persistence can never
silently change the semantics. Crash consistency is proven by SIGKILLing a child process
mid-workload and checking integrity and cross-table invariants on reopen; WAL concurrency by
driving two real OS processes against one database (a harness that found a real bug: WAL
enabled without `busy_timeout`, failing a second concurrent writer instantly). Message storage
is byte-exact, proven by round-trip.

### Queue, bounces, dead letters — RFC 5321 §4.5.4, 3464

Retry semantics under injected time (backoff, permanent-failure-no-retry, the give-up window),
persistence across a kill mid-retry, DSN generation wrapped into full `multipart/report`
bounces (never to a null return path, so bounces cannot loop), and **transactional dead-letter
retention** — a message that exhausts retries moves to the dead-letter table in the same
transaction that removes it from the live queue, so no crash window can lose it.

### Accounts and abuse controls

The account registry stores only SCRAM `StoredKey`/`ServerKey` — a negative-controlled test
proves the password itself is never persisted. Authentication sits behind a per-IP
sliding-window brute-force throttle shared by IMAP and submission; over the threshold, auth is
refused without touching the password (no timing oracle). Deliberately per-IP rather than
per-account, so an attacker cannot lock a victim out of their own mailbox.

### Fuzzing and hostile-input review

The internet-facing parsers (SMTP, MIME, IMAP, address) run under deterministic fuzz harnesses
(~30,000 generated inputs), and every hostile-input subsystem has been security-reviewed with a
**reproduce-first regression test** for each defended attack — among them: forged
`Authentication-Results` injection and strip-bypasses, a duplicate-`From` DMARC display spoof,
a TLS-handshake hang that could wedge the outbound queue, MX-record SSRF to loopback and
private targets, a cross-connection EXPUNGE desync, a quadratic `BODYSTRUCTURE` CPU blow-up,
and an unbounded-RCPT memory exhaustion. These are defects a passing conformance suite and a
fuzzer would both miss.

### End to end

Two daemon instances exchange a signed, dual-`Received`-traced message over real sockets;
real clients (Thunderbird and Apple Mail, desktop and phone) have been driven against a live
deployment through connect, IDLE push, send, flag changes, and delete/EXPUNGE; and the
[performance rigs](PERFORMANCE.md) double as robustness proofs under load.

## Opinionated cuts

Deliberate scope decisions, recorded so they are never mistaken for gaps (the full ledger with
reasons is in [BACKLOG.md](BACKLOG.md) and [the decision records](decisions/0000-about-these-decisions.md)):

- **No POP3.** IMAP4rev2 serves every modern client; POP3 is a whole protocol and harness
  bought for nothing.
- **IMAP4rev2 with a curated extension set** (IDLE, MOVE, UIDPLUS, SPECIAL-USE, CONDSTORE,
  QRESYNC; an `IMAP4rev1` capability is advertised for client compatibility). The legacy
  extension long tail is refused.
- **MTA-STS, not DANE** — DANE needs DNSSEC validation Node's resolver doesn't provide.
- **Modern message parsing** — reject rather than heroically repair; every rejection is a
  register-recorded decision.
- **SCRAM-SHA-256 and PLAIN-over-TLS only.** No CRAM-MD5, no plaintext AUTH, no NTLM.
- **ARC sealing not built** — this server never forwards, so there is nothing to seal;
  verification is the whole useful surface.
- **JMAP** — genuinely modern and genuinely desirable, but additive; the modern-client
  round-trip is already met without it.

## What's still open

The open test-bed items — a Postfix calibration target for the receiver suite, adopting the
openSPF vector suite, a longer `imaptest` soak — live in [BACKLOG.md](BACKLOG.md) with their
reasons and their blockers.
