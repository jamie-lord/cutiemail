# A mail server, built from the byte up

**cutie-mail** is a small, opinionated, self-contained mail server in TypeScript. It sends and
receives real internet mail and speaks the protocols existing clients (Thunderbird, Apple Mail —
desktop and phone) drive, storing everything in SQLite. No mail libraries: the SMTP and IMAP engines, the
MIME parser, and the DKIM/SPF/DMARC crypto are all hand-built on the byte layer. **Zero runtime dependencies** —
Node runs the TypeScript directly, and the only thing in `node_modules` is the type-checker.

The design goal is the one behind the name we use for it internally, the *SQLite of email*:
correct, minimal, and embeddable rather than a sprawling MTA. Scope is chosen deliberately and
every omission is a recorded decision, not a gap — see [docs/WORKING-AGREEMENT.md](docs/WORKING-AGREEMENT.md)
for the philosophy, [docs/TESTING-ROADMAP.md](docs/TESTING-ROADMAP.md) for what is done versus
deliberately left out, and [docs/BACKLOG.md](docs/BACKLOG.md) for what comes next and why.

It is deployed and live: the daemon runs on a small box under real DNS and exchanges
authenticated mail with Gmail (SPF, DKIM, and DMARC all passing), read back over IMAPS.

## Run it

Requires Node ≥ 22.18 (it runs the `.ts` files directly — no build step; an older Node fails with
an unknown-file-extension loader error rather than a friendly message).

```sh
npm install     # only the type-checker; no runtime deps
npm start       # launch the daemon with dev-friendly defaults
```

(The storage layer uses Node's built-in `node:sqlite`, so a direct `node src/main.ts …` prints a
harmless `ExperimentalWarning: SQLite …`. The `npm` scripts silence it with
`--disable-warning=ExperimentalWarning`.)

`npm start` opens the databases and starts three listeners: inbound SMTP, submission SMTP (SASL
PLAIN AUTH over TLS), and IMAPS. There is no config file — everything is configured by environment
variable, and the SQLite files are created on first run (no schema step):

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_DOMAIN` | `mail.example.com` | the local mail domain *and* the SMTP greeting/HELO name |
| `MAIL_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in production) |
| `MAIL_SMTP_PORT` / `MAIL_SUBMISSION_PORT` / `MAIL_IMAP_PORT` | `2525` / `5587` / `5993` | listener ports (use 25 / 587 / 993 in production) |
| `MAIL_USER` (+ `MAIL_PASS`) | unset | set **both** to seed a primary account at boot (create-only, ADR 0012); `MAIL_PASS` is ignored unless `MAIL_USER` is set. Prefer `init`/`account` (below), which keep no password in the environment. With neither set and an empty registry, a `demo`/`demo` dev account is seeded so `npm start` just works. |
| `MAIL_ACCOUNTS` | unset | additional accounts, `"user:pass,user2:pass2"` (each gets its own `mail-<user>.db`); create-only, like `MAIL_USER` |
| `MAIL_CONTROL_DB` | `control.db` | the control database — account registry + outbound queue (created in the **current directory** unless you give a path; point it somewhere real for a deployment) |
| `MAIL_DB` | `mail.db` | the primary account's mailbox database — only read together with `MAIL_USER`. Created by `init` as `mail-<login>.db` beside the control DB. For a fully ephemeral run set `MAIL_CONTROL_DB=:memory:` (every mail DB then defaults to `:memory:`). |
| `MAIL_TLS_CERT` / `MAIL_TLS_KEY` | bundled dev cert | PEM cert/key paths. Unset falls back to a bundled dev cert — but **only on a loopback bind**: the daemon refuses to boot with the dev cert on a non-loopback `MAIL_HOST` (its private key is public), so production must set these (`MAIL_ALLOW_DEV_CERT=1` forces it for a throwaway test). |
| `MAIL_DKIM_KEY` / `MAIL_DKIM_SELECTOR` | unset | PEM RSA key + selector to sign outbound mail |
| `MAIL_TRUSTED_ARC_SEALERS` | unset | comma-separated forwarder domains whose valid ARC chain may rescue a DMARC failure to the inbox |
| `MAIL_MAX_SIZE` | `26214400` | max accepted message size in octets (25 MiB) |

### Send yourself the first email

With no config, `npm start` seeds a `demo`/`demo` account. To prove the whole path works —
authenticated submission, local delivery, read-back — run the built-in check against the running
daemon (in a second terminal):

```sh
node src/main.ts selftest demo   # enter the password: demo
```

A green run means the mail path itself works, not just that a banner printed. To point a real
client (Thunderbird, Apple Mail) at the local dev instance:

- **IMAP** — `127.0.0.1`, port **5993**, security **SSL/TLS** (implicit).
- **SMTP (submission)** — `127.0.0.1`, port **5587**, security **STARTTLS** (not implicit TLS;
  AUTH is only offered after STARTTLS).
- **Username** — the account login exactly (`demo`), **not** `demo@mail.example.com`; it is
  case-sensitive and is not the email address.
- The bundled dev certificate is self-signed, so accept the one-time security exception.

The same entry point is the operator toolbox (`node src/main.ts <command>`):

- **`init <login>`** — first-run bootstrap: creates the primary account (prompts for the
  password, writes SCRAM to the control DB, prints a ready-to-paste systemd unit that carries
  **no** password), and refuses if any account already exists. This is the recommended first
  step; `MAIL_USER`/`MAIL_PASS` are a legacy dev shortcut.
- **`setup`** — generates a DKIM key (if none exists) and prints the exact DNS records to
  publish — MX, SPF, DKIM, DMARC, reverse-DNS — as annotated zone lines derived from the
  server's own configuration.
- **`doctor`** — re-runnable drift check against live DNS and the network: MX, FCrDNS, SPF
  (evaluated by the server's own RFC 7208 evaluator), the published DKIM key matching the
  local private key, DMARC, certificate validity/expiry, and an outbound port-25 probe.
- **`selftest <login>`** — end-to-end proof against the *running* daemon: authenticates,
  submits a tagged message to the account, reads it back over IMAPS, and deletes it again.
  `doctor` checks the outside (DNS, cert, port 25); `selftest` checks the mail path itself.
- **`account add|set-password|enable|disable|list`**, plus **`account alias …`** (route extra
  addresses to an account, ADR 0014) and **`account app-password …`** (revocable per-device
  credentials, ADR 0017) — all managed in the control database; passwords prompted (or piped),
  never in argv or the environment, and the running daemon picks changes up with no restart
  (ADR 0012).
- **`backup <dir>` / `verify`** — a transactionally consistent snapshot of every database
  while the daemon runs, and a read-only proof that a backup (or the live files) passes
  integrity plus the store's own invariants.
- **`queue list` / `dead-letter list|show|requeue|purge`** — what's waiting to go out and
  what delivery permanently gave up on, inspectable down to the retained bytes (`show --raw`
  writes a replayable `.eml`), re-queueable, never silently dropped.

Embedding it instead of running the daemon? `startServer(config)` takes a `MailServerConfig`
object directly, with the same knobs plus injection seams (DNS resolvers, the auth throttle, the
DMARC sampler) that the test suite uses.

To put it on a real box with real DNS and send mail to your own inbox, follow
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — the DNS, systemd, and client walkthrough, with an
honest list of what is intentionally naive.

## What it does

- **Receive** — SMTP on 25 with STARTTLS. Rejects bare CR/LF (the SMTP-smuggling class), enforces
  SIZE, validates recipients against the hosted domain (no open relay, no backscatter), detects
  mail loops, and times out slow-loris connections. Every inbound message is authenticated —
  **SPF + DKIM + DMARC** (aligned over the full Public Suffix List) verified over DNS and recorded
  in an `Authentication-Results` header (with any forged copy of that header stripped first). DMARC
  is **enforced**: a `p=quarantine`/`p=reject` failure is filed to the recipient's Junk folder
  rather than the inbox — never hard-rejected, so legitimate forwarded mail isn't lost. **ARC**
  (RFC 8617) is validated, and a valid chain from a forwarder you trust can rescue such a message
  to the inbox. The message is then trace-stamped and delivered into the addressed account's mailbox.
- **Submit + send** — submission on 587 with SASL PLAIN over TLS. A submitted message is fixed
  up (RFC 6409 — a missing From/Date/Message-ID is added), trace-stamped, **DKIM-signed**, and
  handed to a **persistent SQLite retry queue** that relays it to the recipient's MX over STARTTLS
  (opportunistic, or **MTA-STS-enforced** — validated-TLS-only, no downgrade — when the destination
  publishes a policy) with exponential backoff, giving up only after ~5 days. A permanent failure is
  bounced immediately as a `multipart/report` DSN — never to a null return-path, so bounces can't
  loop — and a given-up message is retained in a dead-letter table for inspection rather than dropped.
- **Read** — IMAPS on 993 with the surface a real client actually drives: `IMAP4rev1`+`IMAP4rev2`,
  `IDLE` (instant new mail), `UIDPLUS`, `SPECIAL-USE` (the Sent/Drafts/Trash/Junk/Archive folders),
  `CONDSTORE` and `QRESYNC` (a reconnecting client resyncs the delta in one round-trip), plus
  `BODYSTRUCTURE` and per-part fetch, `SEARCH`/`ESEARCH`, `MOVE`, and multi-connection sync so a
  phone and a desktop on the same mailbox stay in agreement.
- **Multiple accounts** — one SQLite database per user (a control database holds the SCRAM
  credential registry and the outbound queue; each user gets their own `mail-<user>.db`), with the
  IMAP and submission auth paths behind a per-IP brute-force throttle. Each account can have
  **aliases** and `base+tag` **subaddressing** (extra addresses routed to it, ADR 0014) and
  revocable per-device **app passwords** (ADR 0017); submission is **sender-authorized** — an
  authenticated account can only send *as* an address it owns, so one account can never spoof
  another's `From` (ADR 0015).

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
independent disciplines back the 1,000+ tests:

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
once calibrated against known-good MTAs, with every disagreement triaged to *our bug*, *our
misreading*, or *a genuine divergence*. It has been run against **three independent
implementations — Exim, mox, and aiosmtpd — with zero false positives**; the triaged divergences
(all three honour bare-LF command terminators, a widely-relaxed `MUST NOT`) are recorded in
[reference-servers/](reference-servers/). A Postfix run is the one target still outstanding
(it needs a root-capable host), and the roadmap says so.

## Design decisions

Recorded in [docs/decisions/](docs/decisions/): why RFC 5321 rather than the unpublished 5321bis,
why a from-scratch TypeScript runner, and what the deliberately minimal toolchain leaves out. To
add a corpus module, [src/corpus/AUTHORING.md](src/corpus/AUTHORING.md) is the contract.

## License

[MIT](LICENSE) © Jamie Lord.
