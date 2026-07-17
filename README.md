# A mail server, built from the byte up

A small, opinionated, self-contained mail server in TypeScript. It sends and receives real
internet mail and speaks the protocols existing clients (Thunderbird, Apple Mail — desktop and
phone) drive, storing everything in SQLite. No mail libraries: the SMTP and IMAP engines, the
MIME parser, and the DKIM/SPF/DMARC crypto are all hand-built on the byte layer. **Zero runtime dependencies** —
Node runs the TypeScript directly, and the only thing in `node_modules` is the type-checker.

The design goal is the one behind the name we use for it internally, the *SQLite of email*:
correct, minimal, and embeddable rather than a sprawling MTA. Scope is chosen deliberately and
every omission is a recorded decision, not a gap — see [docs/WORKING-AGREEMENT.md](docs/WORKING-AGREEMENT.md)
for the philosophy and [docs/TESTING-ROADMAP.md](docs/TESTING-ROADMAP.md) for what is done versus
deliberately left out.

It is deployed and live: the daemon runs on a small box under real DNS and exchanges
authenticated mail with Gmail (SPF, DKIM, and DMARC all passing), read back over IMAPS.

## Run it

Requires Node ≥ 22.18 (no build step — it executes the `.ts` files).

```sh
npm install     # only the type-checker; no runtime deps
npm start       # launch the daemon with dev-friendly defaults
```

`npm start` opens the database and starts three listeners: inbound SMTP, submission SMTP (SASL
PLAIN AUTH over TLS), and IMAPS. Everything is configured by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_DB` | `mail.db` | SQLite database path (`:memory:` for ephemeral) |
| `MAIL_DOMAIN` | `mail.example.com` | the local mail domain *and* the SMTP greeting/HELO name |
| `MAIL_HOST` | `127.0.0.1` | bind address |
| `MAIL_SMTP_PORT` / `MAIL_SUBMISSION_PORT` / `MAIL_IMAP_PORT` | `2525` / `5587` / `5993` | listener ports (use 25 / 587 / 993 in production) |
| `MAIL_USER` / `MAIL_PASS` | `demo` / `demo` | the single seeded account |
| `MAIL_TLS_CERT` / `MAIL_TLS_KEY` | bundled dev cert | PEM cert/key paths (a self-signed dev cert is used if unset) |
| `MAIL_DKIM_KEY` / `MAIL_DKIM_SELECTOR` | unset | PEM RSA key + selector to sign outbound mail |

To put it on a real box with real DNS and send mail to your own inbox, follow
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — the DNS, systemd, and client walkthrough, with an
honest list of what is intentionally naive.

## What it does

- **Receive** — SMTP on 25 with STARTTLS. Rejects bare CR/LF (the SMTP-smuggling class), enforces
  SIZE, validates recipients against the hosted domain (no open relay, no backscatter), detects
  mail loops, and times out slow-loris connections. Every inbound message is authenticated —
  **SPF + DKIM + DMARC** verified over DNS and recorded in an `Authentication-Results` header
  (with any forged copy of that header stripped first) — then trace-stamped and stored.
- **Submit + send** — submission on 587 with SASL PLAIN over TLS. A submitted message is fixed
  up (RFC 6409 — a missing From/Date/Message-ID is added), trace-stamped, **DKIM-signed**, and
  handed to a **persistent SQLite retry queue** that relays it to the recipient's MX over
  opportunistic STARTTLS with exponential backoff, giving up (and bouncing) only after ~5 days.
  A permanent failure is bounced immediately as a `multipart/report` DSN — never to a null
  return-path, so bounces can't loop.
- **Read** — IMAPS on 993 with the surface a real client actually drives: `IMAP4rev2`, `IDLE`
  (instant new mail), `UIDPLUS`, `SPECIAL-USE` (the Sent/Drafts/Trash/Junk/Archive folders),
  `CONDSTORE` and `QRESYNC` (a reconnecting client resyncs the delta in one round-trip), plus
  `BODYSTRUCTURE` and per-part fetch, `SEARCH`/`ESEARCH`, `MOVE`, and multi-connection sync so a
  phone and a desktop on the same mailbox stay in agreement.

The wire between every layer is raw bytes: message content is a `Buffer` from the socket to the
SQLite `BLOB` and back, never round-tripped through a JavaScript string. That "bytes, never
strings" rule is what lets a delivered message be read back byte-exact.

## How it's built

The tree is really two programs sharing one spine — the runnable server, and a conformance test
bed that drives *the same code* the daemon runs. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is
the guided tour: the layering from octet primitives up to the daemon, and a byte-by-byte trace of
one message from SMTP in to IMAP out. Start there to read the codebase.

## How it's tested, and why that's trustworthy

Correctness is the point of the project, so the test bed is not an afterthought. Several
independent disciplines back the 700+ tests:

- **The persistent store is proven against a reference model.** The SQLite mailbox and an
  in-memory reference mailbox are driven through one shared invariant harness and must agree
  operation-for-operation, so persistence can't silently change the semantics.
- **Every conformance check is proven to detect its own violation.** Each is run both ways
  against a [mutant server](src/testing/mutant-server.ts) with switchable defects — conformant
  against a clean server, non-conformant against exactly the defect it targets. A test never
  shown to fail is not counted as coverage, and no test is allowed to pass for the wrong reason.
- **Latitude is not scored as failure.** Most of RFC 5321 is SHOULD/MAY. A
  [four-state outcome model](src/conformance/outcome.ts) grades each result by RFC 2119 level: a
  declined SHOULD is *permitted-latitude*, an inconclusive check is neither pass nor fail, and
  only a violated MUST is a finding.
- **Adversarial audits, per subsystem.** Every hostile-input surface (inbound SMTP + auth,
  outbound relay, the IMAP sync/extension surface, and the RFC 5322/MIME parsers) has been put
  through an independent break-it review; the real bugs it found — auth-header spoofing, a
  DMARC display-spoof, a TLS hang that could wedge the send queue, an MX SSRF, a cross-connection
  desync — were each fixed with a reproduce-first regression test. Findings and status are in
  [docs/TESTING-ROADMAP.md](docs/TESTING-ROADMAP.md).

```sh
npm test          # the whole suite, including the negative-control proofs
npm run typecheck # tsc --noEmit; strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes, …)
```

## The SMTP conformance suite

The receiver's test bed doubles as a standalone tool: an **SMTP conformance suite** you can point
at *any* mail server. It exists because nothing else quite does — there are good IMAP (Dovecot's
`imaptest`) and JMAP (Fastmail's JMAP-TestSuite) conformance tools, but for SMTP the field is
load generators and fakes, not compliance checkers.

Everything traces to a [requirement register](src/register/): the normative statements of RFC 5321
§§1–7 plus the STARTTLS command-injection requirement of RFC 3207 §4.2, each quoted **verbatim**
(a test checks every quote against the vendored RFC), tagged with its RFC 2119 level, the party it
binds, and whether it is observable from a receiver socket at all — many bind the client or need a
receiving sink, and the register says so rather than hide behind a flattering percentage.

```sh
node src/cli.ts coverage                              # what's tested, deliberately uncovered, or not testable
node src/cli.ts list                                  # every corpus case and the requirement it checks
node src/cli.ts run --config reference-servers/postfix.json
```

A finding exits 1, a clean run exits 0, a config error exits 2 — so it drops into CI. The `fixture`
block in a target config is how the suite is told about state it cannot create over the wire (a
valid recipient, a domain the server won't relay to, a declared size limit); a check that needs a
fixture the run lacks yields *inconclusive*, never a false pass. That in-band-state problem is what
makes SMTP conformance harder than IMAP — see [src/conformance/fixture.ts](src/conformance/fixture.ts).

The flagship coverage is the CRLF/SMTP-smuggling corpus (the `<LF>.<LF>`, `<LF>.<CR><LF>`, and
`<CR>.<CR>` end-of-data variants) and the RFC 3207 STARTTLS session-security class (pre-handshake
injection, smuggle-into-TLS, and the §4.2 post-handshake reset). The wire-level attack detail is
distilled, with sources, in [docs/research/smtp-divergence.md](docs/research/smtp-divergence.md).

**Calibration before trust.** The runner is our own code, so its verdicts are only trustworthy
once calibrated against known-good MTAs (Postfix, Exim), with every disagreement triaged to *our
bug*, *our misreading*, or *a genuine divergence*. That step (see [reference-servers/](reference-servers/))
is deliberately still outstanding, and the roadmap says so.

## Design decisions

Recorded in [docs/decisions/](docs/decisions/): why RFC 5321 rather than the unpublished 5321bis,
why a from-scratch TypeScript runner, and what the deliberately minimal toolchain leaves out. To
add a corpus module, [src/corpus/AUTHORING.md](src/corpus/AUTHORING.md) is the contract.
