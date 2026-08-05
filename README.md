[![cutiemail: a small, self-contained mail server in TypeScript](https://cuti.email/assets/banner.png)](https://cuti.email)

# A mail server, built from the byte up

**cutiemail** is a small, opinionated, self-contained mail server in TypeScript. It sends and
receives real internet mail. It speaks the protocols that existing clients drive (Thunderbird, and
Apple Mail on desktop and phone). It stores everything in SQLite. It uses no mail libraries. The
SMTP and IMAP engines, the MIME parser, and the SPF/DKIM/DMARC logic are all written here on the
byte layer, over Node's own `node:crypto` and `node:sqlite`. **Zero runtime dependencies**: you
install only Node.js itself. `node_modules` holds nothing but dev tooling (the TypeScript
type-checker and its type definitions), and the server never loads any of it.

The *SQLite of email* is the best way to say the design goal. Email cannot be serverless the way
SQLite is, because something must answer when the rest of the internet knocks on port 25. So the
phrase means everything else that people reach SQLite for: small enough to read, zero configuration
to start, zero runtime dependencies, your mail in plain files that you can query, and correctness
treated as the product. The scope is deliberate, and every omission is a recorded decision, not a
gap. See [the working agreement](docs/WORKING-AGREEMENT.md) for the philosophy, [how it's
tested](docs/TESTING.md) for what is done and what is deliberately left out, and [the
backlog](docs/BACKLOG.md) for what is still open and what was declined, with reasons.

It is deployed and live. The daemon runs on a small box under real DNS. It exchanges authenticated
mail with Gmail (SPF, DKIM, and DMARC all pass), and you read that mail back over IMAPS.

## Why this, and when to use something else

Stalwart, Maddy, Mox, and Mailcow are all good software. If you want a batteries-included groupware
stack or JMAP, use them. cutiemail makes a different bet: **smallness you can read**. It gives you
one process, one language, zero runtime dependencies, plain SQLite files that you can query with
stock `sqlite3`, and a from-scratch implementation where every protocol byte is code in this repo.
Correctness comes first, and the test bed is the star of the show (reference-model storage proofs,
mutant-server negative controls, and self-audited hostile-input surfaces). Some things are
deliberately **not** here, and each one is a recorded decision with reasons ([how it's
tested](docs/TESTING.md), [the backlog](docs/BACKLOG.md)): POP3, JMAP, Sieve, webmail, a spam
filter beyond DMARC enforcement, multiple domains per instance, and clustering. It serves one
domain and a handful of humans best, on a small box that you own.

**Maturity:** young (v0, one maintainer), but held to a high verification bar: more than 1,500
tests that include negative controls, self-audited hostile-input surfaces, and a production
instance that exchanges authenticated mail with Gmail every day. Before you run it for mail you
care about, read the honest limitations in [the deployment guide](docs/DEPLOYMENT.md).

**Platforms:** developed and tested on Linux and macOS. On Windows, use WSL2. The daemon itself is
plain Node, but the 0600/0700 file-permission hardening does nothing on NTFS, and the deployment
guide covers Linux and systemd only.

## Run it

cutiemail needs **Node.js ≥ 22.18**. It runs the `.ts` files directly, so there is no build step.
On an older Node, `npm install` refuses with an unsupported-engine error that names the required
version. This is `.npmrc`'s `engine-strict` at work. It is much friendlier than the loader error
that an old Node hits at `npm start`. Note that the Node in the `apt` of Debian and Ubuntu is
usually too old. Install Node 22 from [NodeSource](https://github.com/nodesource/distributions)
instead. [The deployment guide](docs/DEPLOYMENT.md) has the exact commands.

```sh
node --version  # v22.18.0 or newer
git clone https://github.com/jamie-lord/cutiemail
cd cutiemail
npm install     # dev tooling only (the type-checker), nothing the server runs
npm start       # the daemon, with dev-friendly defaults
```

(The storage layer uses Node's built-in `node:sqlite`, so a direct `node src/main.ts …` prints a
harmless `ExperimentalWarning: SQLite …`. The `npm` scripts silence it with
`--disable-warning=ExperimentalWarning`.)

`npm start` opens the databases and starts three listeners: inbound SMTP, submission SMTP (SASL
PLAIN AUTH over TLS), and IMAPS. It binds `127.0.0.1` only, a private plaything on the machine in
front of you. To put it on a real server with real DNS, follow [the deployment
guide](docs/DEPLOYMENT.md). Leave it running, because it is a foreground daemon. To stop it, use
Ctrl-C or SIGTERM at any time. Shutdown is graceful, and the SQLite databases are crash-safe.

**State lands beside the code**: cutiemail creates the control and mailbox databases in the working
directory. `npm start` always runs from the repo root, and the startup banner prints the resolved
path. So run it from the same place each time, or set `MAIL_CONTROL_DB` to an absolute path.

There is no config file. The zero-config run needs no variables at all. You set everything else by
environment variable (the [configuration reference](#configuration-reference) below is the full
list). cutiemail creates the SQLite files on first run, with no schema step. On PowerShell, set
variables as `$env:MAIL_DOMAIN='...'` before `npm start`. The `VAR=value command` one-liners below
are POSIX-shell syntax.

New to running mail? Before you touch a real domain, start with the picture in [the deployment
guide's "The shape of it"](docs/DEPLOYMENT.md#the-shape-of-it). It gives a plain-English map of the
moving parts (MX, SPF, DKIM, DMARC).

### Send yourself the first email

With no config, `npm start` seeds a `demo`/`demo` account on loopback binds only. A public bind
refuses to boot until `init` creates a real account, so this convenience credential can never go
live on the internet. To prove the whole path works (authenticated submission, local delivery,
read-back), run the built-in check **in a second terminal, while the daemon runs**. Use the same
`MAIL_*` environment as the daemon, because the check dials the configured ports. With no variables
set on either side, the defaults line up:

```sh
node src/main.ts selftest demo   # enter the password: demo
```

A green run means the mail path itself works, not just that a banner printed. (`selftest` deletes
the test message after it reads it back, so the inbox ends empty. `selftest` also warns if the
server's greeting does not match the expected domain.) To point a real client (Thunderbird, Apple
Mail) at the local dev instance:

- **IMAP**: `127.0.0.1`, port **5993**, security **SSL/TLS** (implicit).
- **SMTP (submission)**: `127.0.0.1`, port **5587**, security **STARTTLS** (not implicit TLS). The
  server offers AUTH only after STARTTLS.
- **Username**: the account login (`demo`), **not** `demo@mail.example.com`. A login is a
  case-insensitive identity, so `demo` and `DEMO` are the same account. It is *not* the email
  address.
- The bundled dev certificate is self-signed, and its name does not match `127.0.0.1` (it is a
  throwaway dev cert, not issued for your machine). So accept the one-time security exception.

The same entry point is the operator toolbox: `node src/main.ts <command>`, run from the repo
folder. Read the pair as one word, the way `systemctl <verb>` is one word:

- **`init <login>`**: the first-run bootstrap. It creates the primary account (it prompts for the
  password, writes SCRAM to the control DB, and prints a ready-to-paste systemd unit that carries
  **no** password). It refuses if any account already exists. This is the recommended first step
  **for a fresh deployment directory**. Note that a bare `npm start` has already seeded
  `demo`/`demo`, which forecloses `init` there. Use `account add` instead. `MAIL_USER`/`MAIL_PASS`
  are a legacy dev shortcut.
- **`setup`**: generates a DKIM key (if none exists). It prints the exact DNS records to publish
  (MX, SPF, DKIM, DMARC, reverse-DNS) as annotated zone lines. It derives the lines from the
  server's own configuration.
- **`doctor`**: a re-runnable drift check against live DNS and the network. It covers MX, FCrDNS,
  SPF (evaluated by the server's own RFC 7208 evaluator), the match between the published DKIM key
  and the local private key, DMARC, certificate validity and expiry, and an outbound port-25 probe.
- **`selftest <login>`**: an end-to-end proof against the *running* daemon. It authenticates,
  submits a tagged message to the account, reads it back over IMAPS, and deletes it again. `doctor`
  checks the outside (DNS, cert, port 25). `selftest` checks the mail path itself.
- **`account add|set-password|enable|disable|list`**, plus **`account alias …`** (route extra
  addresses to an account, ADR 0014) and **`account app-password …`** (revocable per-device
  credentials, ADR 0017). The control database holds all of these. You enter passwords at a prompt
  (or pipe them), never in argv or the environment. The running daemon reads changes with no
  restart (ADR 0012).
- **`backup <dir>` / `verify`**: `backup` makes a transactionally consistent snapshot of every
  database while the daemon runs. `verify` is a read-only proof that a backup (or the live files)
  passes integrity checks and the store's own invariants.
- **`queue list|retry|cancel` / `dead-letter list|show|requeue|purge`**: `queue` shows what is
  waiting to go out. Use `retry <id>|--all` to skip the backoff after you fix a fault. Use `cancel`
  to pull a message. cutiemail retains it in dead-letter and never discards it. `dead-letter` shows
  what delivery permanently gave up on. You can inspect it down to the retained bytes (`show --raw`
  writes a replayable `.eml`) and re-queue it, and cutiemail never drops it silently.
- **`mail list|show <login>`**: read a delivered mailbox without an IMAP client. It shows uid, date,
  size, flags, and From/Subject for each message. `show <uid> --raw` streams the byte-exact `.eml`.
  It is read-only (it marks nothing seen), the quick "did it arrive" check for a shell or CI.

`node src/main.ts help` lists all of these. A bare `node src/main.ts` starts the daemon.

### Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_DOMAIN` | `mail.example.com` | the local mail domain *and* the SMTP greeting/HELO name |
| `MAIL_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in production) |
| `MAIL_SMTP_PORT` / `MAIL_SUBMISSION_PORT` / `MAIL_IMAP_PORT` | `2525` / `5587` / `5993` | listener ports (use 25 / 587 / 993 in production) |
| `MAIL_USER` (+ `MAIL_PASS`) | unset | set **both** to seed a primary account at boot (create-only, ADR 0012). cutiemail ignores `MAIL_PASS` unless you set `MAIL_USER`. Prefer `init`/`account` (above), which keep no password in the environment. If you set neither and the registry is empty, cutiemail seeds a `demo`/`demo` dev account so `npm start` just works, on a **loopback bind only**. A public bind refuses to boot instead. |
| `MAIL_ACCOUNTS` | unset | additional accounts, `"user:pass,user2:pass2"` (each gets its own `mail-<user>.db`). Create-only, like `MAIL_USER`. **Every entry must contain a colon**. A malformed entry fails the boot and names itself, rather than being dropped silently. cutiemail skips an entry that collides with an existing login only by case, or whose name an alias already claims, and logs a warning. |
| `MAIL_CONTROL_DB` | `control.db` | the control database: account registry and outbound queue. cutiemail creates it in the **current directory** unless you give a path. Point it somewhere real for a deployment. |
| `MAIL_DB` | `mail.db` | the primary account's mailbox database. cutiemail reads it only together with `MAIL_USER`. The seeded `demo` account also uses this file (so a bare `npm start` creates `control.db` and `mail.db`). Accounts that `init`/`account` create get `mail-<login>.db` beside the control DB instead. For a fully ephemeral run, set `MAIL_CONTROL_DB=:memory:` (every mail DB then defaults to `:memory:`). |
| `MAIL_TLS_CERT` / `MAIL_TLS_KEY` | bundled dev cert | PEM cert and key paths. If unset, cutiemail falls back to a bundled dev cert, but **only on a loopback bind**. The daemon refuses to boot with the dev cert on a non-loopback `MAIL_HOST`, because its private key is public. So production must set these (`MAIL_ALLOW_DEV_CERT=1` forces the dev cert for a throwaway test). If a set path cannot be read, the boot fails with a message that names the variable. |
| `MAIL_DKIM_KEY` / `MAIL_DKIM_SELECTOR` | unset | PEM RSA key and selector to sign outbound mail |
| `MAIL_TRUSTED_ARC_SEALERS` | unset | comma-separated forwarder domains. A valid ARC chain from one of these can rescue a DMARC failure to the inbox. |
| `MAIL_MAX_SIZE` | `26214400` | the maximum accepted message size in octets (25 MiB). It applies to SMTP `SIZE` and the IMAP `APPEND` literal alike. |
| `MAIL_OUTBOUND` | `deliver` | set `hold` for a dev/test sink. cutiemail queues remote mail (inspect it with `queue list`) but **never relays it**, so nothing can escape a test instance (ADR 0019). Any other value refuses to boot. |
| `MAIL_DEBUG` | unset | `1` logs every received SMTP/IMAP command line to stderr (credentials redacted, control characters stripped), the protocol-level debugging view. The log still records who tried to authenticate and from where, so treat it as sensitive. |

Do you run it from your own code instead of as a standalone daemon? `startServer(config)` takes a
`MailServerConfig` object directly, with the same knobs plus the injection seams that the test
suite uses (DNS resolvers, the auth throttle, the DMARC sampler).

To put it on a real box with real DNS and send mail to your own inbox, follow [the deployment
guide](docs/DEPLOYMENT.md). It is the DNS, systemd, and client walkthrough, with an honest list of
what is intentionally naive. Do you prefer containers? A `Dockerfile` and `docker-compose.yml` are
at the repo root (`docker compose up -d`). Zero runtime deps and no build step make the image just
the Node runtime plus the source ([ADR 0020](docs/decisions/0020-container-image.md)).

### Use it as a dev/test mail server

It makes a good Mailpit-style sink when you develop an app that sends mail. It is a *real*
SMTP/IMAP server, so your code exercises real protocol behaviour:

```sh
MAIL_CONTROL_DB=./devmail.db MAIL_OUTBOUND=hold npm start
```

`hold` guarantees that cutiemail never relays anything to the real internet (fixtures with
real-looking addresses stay on the box). The seeded `demo`/`demo` account accepts submissions, and
`+tag` subaddressing gives each test its own address. The file-backed `MAIL_CONTROL_DB` is
deliberate. The inspection commands run as separate processes, so `queue list` and `mail list demo`
can see the queue and mailbox only when they share an on-disk database with the daemon. Those
commands, plus `selftest demo`, are your assertions. When you are done, delete `devmail.db` and any
`mail-*.db`. (For a purely ephemeral run, use `MAIL_CONTROL_DB=:memory:`. Then assert only over the
wire, through `selftest` or an IMAP client, because a second process cannot read another process's
in-memory database.)

### Your data, your exit

cutiemail stores mail byte-exact, so leaving is as easy as arriving. Copy mailboxes out over IMAP
with any tool (imapsync, a desktop client), read the plain SQLite files directly with stock
`sqlite3`, or dump a single message as a `.eml` with `mail show <login> <uid> --raw`. An import of
15 years of history works the same way. See "Migrating your existing mail" in [the deployment
guide](docs/DEPLOYMENT.md).

## What it does

The ports named below are the standard protocol ports (the production defaults). The local dev
instance from "Run it" uses `2525`/`5587`/`5993` instead, per the [configuration
reference](#configuration-reference).

- **Receive**: SMTP on 25 with STARTTLS. It rejects bare CR/LF (the SMTP-smuggling class), enforces
  SIZE, validates recipients against the hosted domain (no open relay, no backscatter), detects
  mail loops, and times out slow-loris connections. It authenticates every inbound message: it
  verifies **SPF + DKIM + DMARC** over DNS (aligned over the full Public Suffix List) and records
  the result in an `Authentication-Results` header. It strips any forged copy of that header first.
  It **enforces** DMARC: it files a `p=quarantine`/`p=reject` failure to the recipient's Junk folder
  rather than the inbox, and never hard-rejects it, so legitimate forwarded mail is not lost. It
  validates **ARC** (RFC 8617), and a valid chain from a forwarder you trust can rescue such a
  message to the inbox. It then trace-stamps the message and delivers it into the addressed
  account's mailbox. It commits the message to disk (WAL `synchronous=FULL`) *before* it sends the
  `250`, so an accepted message survives a power cut, not just a clean restart ([ADR
  0028](docs/decisions/0028-durability-fsync-before-acknowledgement.md)).
- **Submit + send**: submission on 587 with SASL PLAIN over TLS. cutiemail fixes up a submitted
  message (RFC 6409: it adds a missing From/Date/Message-ID), trace-stamps it, **DKIM-signs** it,
  and hands it to a **persistent SQLite retry queue**. That queue relays it to the recipient's MX
  over STARTTLS with exponential backoff, and gives up only after about 5 days. The relay is
  opportunistic, or **MTA-STS-enforced** (validated-TLS-only, no downgrade) when the destination
  publishes a policy. cutiemail bounces a permanent failure at once as a `multipart/report` DSN,
  never to a null return-path, so bounces cannot loop. It retains a given-up message in a
  dead-letter table for inspection. It never drops it.
- **Read**: IMAPS on 993 with the surface that a real client drives. It offers
  `IMAP4rev1`+`IMAP4rev2`, `IDLE` (instant new mail), `UIDPLUS`, `SPECIAL-USE` (the
  Sent/Drafts/Trash/Junk/Archive folders), `CONDSTORE` and `QRESYNC` (a reconnecting client
  resyncs the delta in one round-trip), plus `BODYSTRUCTURE` and per-part fetch, `SEARCH`/`ESEARCH`,
  `MOVE`, and multi-connection sync so a phone and a desktop on the same mailbox stay in agreement.
- **Multiple accounts**: one SQLite database per user. A control database holds the SCRAM credential
  registry and the outbound queue, and each user gets their own `mail-<user>.db`. The IMAP and
  submission auth paths sit behind a per-IP brute-force throttle. Each account can have **aliases**
  and `base+tag` **subaddressing** (extra addresses routed to it, ADR 0014) and revocable per-device
  **app passwords** (ADR 0017). Submission is **sender-authorized**: an authenticated account can
  send *as* only an address that it owns, so one account can never spoof another account's `From`
  (ADR 0015).
- **Keep itself patched**: self-hosted software rots, because an upgrade is a chore that nobody
  schedules. So a deployment can pull its own updates. cutiemail verifies a candidate version *on
  your machine against a snapshot of your real data* before a `rename(2)` over a symlink switches to
  it. It runs and times the migration. It then compares your accounts and messages byte for byte.
  The version that you run now must still be able to read what the new one migrated. If you sign
  your mail, cutiemail checks a held outbound copy for a `DKIM-Signature` that carries your domain.
  If the live mail path does not work after the switch, it reverses the switch on its own. The
  updater runs as a **separate user**, so the internet-facing daemon can never write the code that
  it will run next (ADR 0025). It is off by default, and reporting-only when enabled. See [keeping a
  deployment up to date](docs/SELF-UPDATE.md).

The wire between every layer is raw bytes. Message content is a `Buffer` from the socket to the
SQLite `BLOB` and back, and it is never round-tripped through a JavaScript string. That "bytes,
never strings" rule is what lets you read a delivered message back byte-exact.

## How it's built

The tree is really three programs that share one spine: the runnable server, a conformance test bed
that drives *the same code* the daemon runs, and an updater. The updater runs as a different user
and verifies a candidate version with the server's own store and conformance code. [The architecture
guide](docs/ARCHITECTURE.md) is the guided tour: the layering from octet primitives up to the
daemon, and a byte-by-byte trace of one message from SMTP in to IMAP out. Start there to read the
codebase.

## How it's tested, and why that's trustworthy

Correctness is the point of the project, so the test bed is not an afterthought. Several
independent disciplines back the 1,500+ tests:

- **The persistent store is proven against a reference model.** One shared invariant harness drives
  the SQLite mailbox and an in-memory reference mailbox. They must agree operation-for-operation, so
  persistence cannot change the semantics silently.
- **Every conformance check is proven to detect its own violation.** cutiemail runs each check both
  ways against a [mutant server](src/testing/mutant-server.ts) with switchable defects: conformant
  against a clean server, and non-conformant against exactly the defect that it targets. A test that
  is never shown to fail does not count as coverage, and no test can pass for the wrong reason.
- **Latitude is not scored as failure.** Most of RFC 5321 is SHOULD/MAY. A [four-state outcome
  model](src/conformance/outcome.ts) grades each result by RFC 2119 level: a declined SHOULD is
  *permitted-latitude*, an inconclusive check is neither pass nor fail, and only a violated MUST is
  a finding.
- **Hostile-input hardening, per subsystem.** The maintainer reviews and regression-tests each
  hostile-input surface (inbound SMTP + auth, outbound relay, the IMAP sync/extension surface, and
  the RFC 5322/MIME parsers) against the attacks found there so far: auth-header spoofing, DMARC
  display-spoofing, a TLS hang that could wedge the send queue, MX SSRF, cross-connection desync,
  and algorithmic blow-ups that a crafted message can trigger from a client's own routine `FETCH`. A
  quadratic address parse in `ENVELOPE` froze the event loop for about 27 s on a 256 KiB `To:`
  header before it was made linear, alongside a header-section byte cap, a BODYSTRUCTURE budget, and
  linear `LIST`/`LSUB` matching. Each fix carries a test that fails on the vulnerable code. The
  review is the maintainer's own, not a third party's. Coverage and status are in [how it's
  tested](docs/TESTING.md).

```sh
npm test          # the whole suite, including the negative-control proofs
npm run typecheck # tsc --noEmit; strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes, …)
```

## The SMTP conformance suite

The receiver's test bed doubles as a standalone tool: an **SMTP conformance suite** that you can
point at *any* mail server. It exists because nothing else quite does. Good IMAP (Dovecot's
`imaptest`) and JMAP (Fastmail's JMAP-TestSuite) conformance tools exist, but for SMTP the field is
load generators and fakes, not compliance checkers.

Everything traces to a [requirement register](src/register/). For the SMTP suite, this is the
normative statements of RFC 5321 §§1-7 plus the STARTTLS command-injection requirement of RFC 3207
§4.2 (the register spans other RFCs and domains too — see the architecture guide). It quotes each
statement **verbatim** (a test checks every quote against the vendored RFC), and tags it with its
RFC 2119 level, the party that it binds, and whether it is observable from a receiver socket at all.
Many statements bind the client or need a receiving sink, and the register says so rather than hide
behind a flattering percentage.

```sh
node src/cli.ts coverage                              # what's tested, deliberately uncovered, or not testable
node src/cli.ts list                                  # every corpus case and the requirement it checks
node src/cli.ts run --config reference-servers/exim.json
```

A finding exits 1, a clean run exits 0, and a config error exits 2, so it drops into CI. The
`fixture` block in a target config tells the suite about state that it cannot create over the wire
(a valid recipient, a domain that the server will not relay to, a declared size limit). A check that
needs a fixture the run lacks yields *inconclusive*, never a false pass. That in-band-state problem
is what makes SMTP conformance harder than IMAP. See
[src/conformance/fixture.ts](src/conformance/fixture.ts).

The flagship coverage is the CRLF/SMTP-smuggling corpus (the `<LF>.<LF>`, `<LF>.<CR><LF>`, and
`<CR>.<CR>` end-of-data variants) and the RFC 3207 STARTTLS session-security class (pre-handshake
injection, smuggle-into-TLS, and the §4.2 post-handshake reset). [The SMTP divergence
notes](docs/research/smtp-divergence.md) distill the wire-level attack detail, with sources.

**Calibration before trust.** The runner is our own code, so its verdicts are trustworthy only
after calibration against known-good MTAs, with every disagreement triaged to *our bug*, *our
misreading*, or *a genuine divergence*. It has run against **four independent implementations
(Postfix, Exim, mox, and aiosmtpd) with zero false positives**. The triaged divergences (all four
honour bare-LF command terminators, a widely-relaxed `MUST NOT`) are recorded in
[reference-servers/](reference-servers/). Postfix ran in two configurations, one vulnerable to SMTP
smuggling and one hardened against it. The suite flagged the smuggling vectors on the first and
cleared them on the second. This is the strongest evidence that it convicts a real defect without
convicting a hardened server.

## Design decisions

Recorded as ADRs in [docs/decisions/](docs/decisions/0000-about-these-decisions.md): why RFC 5321 rather than the unpublished 5321bis,
why a from-scratch TypeScript runner, and what the deliberately minimal toolchain leaves out. To
add a corpus module, use [the corpus authoring guide](src/corpus/AUTHORING.md) as the contract.

## Contributing & security

Contributions are welcome. Read [the contributing guide](CONTRIBUTING.md) first. The project is
deliberately scoped, so the "why it earns its place" bar matters. Did you find a security bug?
Please report it privately per [the security policy](SECURITY.md), not in a public issue.

## License

[MIT](LICENSE) © Jamie Lord.
