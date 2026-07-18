# Backlog — operator-experience work, grounded in evidence

*Written 2026-07-18. Sources: a full qualitative read of the 308-comment Hacker News
discussion of Mox ([news.ycombinator.com/item?id=43261729](https://news.ycombinator.com/item?id=43261729))
and a feature/interface review of Mox itself ([xmox.nl](https://www.xmox.nl),
[github.com/mjl-/mox](https://github.com/mjl-/mox)). Nothing here is copied because Mox has
it; every item had to clear the [working agreement's bar](WORKING-AGREEMENT.md) — one honest
sentence, rooted in the vision, for why it measurably improves the project for an end user.*

## What the evidence says

The HN thread's centre of gravity is not features — it is **confidence**. The dominant
themes, by comment volume:

1. **Deliverability anxiety** (~80+ comments, contested): the closest thing to a synthesis
   is that personal-scale mail from a clean host with correct SPF/DKIM/DMARC/rDNS mostly
   works — and that most failures trace to *setup mistakes, provider choice, domain age,
   or silent drift*, not to some unfixable cabal. The recurring fear is epistemic:
   *"I'm curious to know how you could know if any emails you send are getting silently
   dropped."* (AnonHP)
2. **Setup complexity of the traditional stack** (~20 comments): *"a 20+ hour byzantine
   nightmare of setting up postfix & dovecot… an even more kafkaesque nightmare of rspamd
   (with its 3 different programming languages… 92+ configuration files)"* (QuadrupleA).
3. **Maintenance burden**: the people who quit self-hosting cite hours-per-month upkeep;
   the happy Mox users cite the opposite — *"Running backup & update every couple months
   takes <5 min"* (kbmn).

What people praise about Mox, ranked by frequency: **the quickstart** — above all that it
*generates and prints the exact DNS records* and pre-flights the classic failure modes
(outbound port 25 blocked, too-young domain) — then rock-solid stability, low resource
use, and the all-in-one integration of the auth cluster. *"The beauty of Mox is that it
tells you what exact DNS records you need to set up"* (jnd-cz).

The lesson for cutie-mail is sharp: **our protocol engine is already the hard part, and it
is done and live-verified. What the evidence says end users actually struggle with is the
last mile — knowing their DNS is right, knowing mail is flowing, and operating the thing
over time.** That is squarely inside the mission ("very simple to INSTALL and OPERATE"
is a core property of the vision, not an accessory), and it is currently served only by
prose in [DEPLOYMENT.md](DEPLOYMENT.md).

Equally important, the evidence *validates* choices already made, so they are not
re-litigated below: never silently dropping mail (Mox's author: rejecting outright or
delivering — *"it's that behaviour from the bigmail providers I don't like and undermines
trust in email!"* — our DMARC-to-Junk-never-reject is the same instinct); built-in auth
throttling (*"potentially eliminating the need for fail2ban"*); one self-contained
artifact instead of a stack; and SQLite-per-user storage.

## The backlog

Ordered. Each item states its evidence, its one-sentence mission justification, its shape,
and how it will be tested — per the working agreement, an item that can't fill in all four
doesn't get listed.

### B1 — `setup`: DKIM keygen + annotated DNS record generation

- **Evidence:** the single most-praised Mox feature in the whole thread; the direct
  antidote to the top setup pain (hand-assembling the deliverability DNS cluster is where
  first-time operators fail).
- **Mission fit:** we implement SPF/DKIM/DMARC end-to-end, but the operator must hand-derive
  the records from prose — generating them from the same code that enforces them is the
  "simple to install" promise kept by the engine itself.
- **Shape:** a subcommand that (a) generates a DKIM keypair if none exists (Ed25519 +
  RSA, reusing the existing key handling — never overwriting), and (b) prints annotated,
  copy-pasteable zone lines derived from the server's own config: MX, SPF (with the box's
  IP), the DKIM TXT computed from the private key, DMARC, and the rDNS/FCrDNS instruction.
  Re-runnable at any time to reprint records from existing keys (Mox's `config dnsrecords`
  insight: regeneration matters as much as first generation).
- **Testing:** the record rendering is a pure function of config + key material — unit-tested
  exactly, including the DKIM public-key derivation against the existing RFC-pinned vectors;
  then one live verification: records generated for `mailtest.lord.technology` must match
  what is actually published (they were hand-built — the generator must agree with reality).

### B2 — `doctor`: live preflight and drift check

- **Evidence:** Mox's quickstart pre-flights outbound port 25 (the classic VPS gotcha) and
  domain age via RDAP; the thread's deepest fear is drift — *"Gmail accepted my emails
  fine... until one day it didn't"* (jks). A re-runnable checker converts that anxiety into
  a command.
- **Mission fit:** correctness-first applies to the deployment, not just the protocol —
  a server whose DKIM selector silently mismatches its published key is *wrong*, and we
  already own every primitive needed to detect it.
- **Shape:** a subcommand that checks, against live DNS and the network: MX points at this
  host; A/AAAA and FCrDNS agree; the published SPF authorises this box's IP; the DKIM TXT
  at the configured selector matches the local private key; DMARC is present; the TLS cert
  chain is valid and not near expiry; outbound port 25 is dialable. Optional cheap extras:
  RDAP domain age (one HTTPS JSON fetch — flags the fresh-domain spam-foldering confounder
  a user hit live in the thread). Clear pass/warn/fail output, non-zero exit on fail.
- **Testing:** every check unit-tested through the existing injected-resolver seams (fake
  DNS, fake dial results — both directions: detects the broken state, passes the good one);
  one recorded live run against the mailtest box. Note: our own box currently has exactly
  the kind of latent drift this catches — certbot renewal is not re-provisioned since the
  migration, so cert expiry *will* eventually bite; `doctor` is the tool that notices.

### B3 — account provisioning CLI: passwords out of the environment

- **Evidence:** the setup-complexity theme generally, and Mox's account model (accounts are
  server state managed by the operator, not OS users or boot-time parameters).
- **Mission fit:** the SCRAM registry was deliberately designed to store only
  StoredKey/ServerKey, never the password — but today every boot re-feeds plaintext
  passwords through `MAIL_USER/PASS`/`MAIL_ACCOUNTS`, which means they live forever in the
  systemd unit; closing that hole is a genuine security correction, not a convenience.
- **Shape:** `account add / set-password / remove / list` subcommands writing the control-DB
  registry directly (prompting for the password, never taking it as an argv argument —
  argv is visible in `ps`). Env-var accounts remain supported for dev/ephemeral use; the
  precedence between env-provisioned and CLI-provisioned accounts is a design decision to
  record as an ADR when built (the obvious candidate: CLI-managed registry is the source of
  truth; env seeds only a missing account, never overwrites).
- **Testing:** registry round-trip tests already exist — extended to the CLI path; a
  negative control proving the plaintext never lands in the DB (the existing invariant);
  live verification: provision an account on the box with no password in the unit file,
  authenticate over IMAPS.

### B4 — `backup` + `verify`: the SQLite payoff

- **Evidence:** the maintenance-burden theme is what makes people quit; the happy Mox
  users cite the backup/update loop being minutes. Mox needs a dedicated
  `backup`/`verifydata` pair because its store is thousands of message files plus an index
  DB — ours is *n* SQLite files, which is the "SQLite of email" ethos paying out.
- **Mission fit:** a mail server whose entire state can be snapshotted and verified with
  one command each is the operational meaning of the project's name.
- **Shape:** `backup <destdir>` — a consistent online snapshot of control.db + every
  `mail-<user>.db` (SQLite's online backup API / `VACUUM INTO`, both WAL-safe; mechanism
  chosen at build time against our Node version). `verify <dir>` — `PRAGMA
  integrity_check` plus the cross-table invariants the crash-consistency suite already
  proves (UID monotonicity, queue/dead-letter partition, catalog/mailbox agreement),
  runnable against a backup or the live files. Docs must state the WAL caveat plainly: a
  naive `cp` of a live DB is not a backup.
- **Testing:** backup taken *under concurrent write load* (the existing concurrency harness
  provides this) must verify clean and reopen with all invariants intact; `verify` proven
  to detect a deliberately corrupted file (negative control — a verifier never shown to
  fail is not coverage).

### B5 — queue + dead-letter operator CLI

- **Evidence:** the silent-drop fear (AnonHP, §above) and Mox's queue tooling
  (`queue list/hold/fail/dump…`) — the operator's answer to "did my mail actually leave?"
- **Mission fit:** we built dead-letter retention precisely so no message is ever silently
  lost, but the API is programmatic only — retention without inspectability is a promise
  the operator can't check.
- **Shape:** `queue list` (pending sends, next-attempt times, attempt counts) and
  `dead-letter list / show <id> / requeue <id> / purge <id>` wrapping the existing
  `listDeadLetters`/`getDeadLetter`/`requeueDeadLetter`/`purgeDeadLetter` API. Read-only
  except the two existing mutation verbs. Smallest item on the list.
- **Testing:** the API is already tested; the CLI layer gets exact-output tests plus one
  live check on the box (a queued message visible, a dead-letter requeued and delivered).

### B6 — inbound MTA-STS policy publication (+ client autoconfig) — *decision required*

- **Evidence:** we *enforce* MTA-STS outbound but publish no policy of our own, so a sender
  cannot protect mail addressed **to us** from TLS downgrade; Thunderbird-style autoconfig
  removes the last manual step of client setup. Mox bundles a webserver for exactly these
  static needs.
- **Mission fit (the tension, stated honestly):** both are single static documents served
  over TLS we already terminate — but they require an HTTPS listener and certificate
  coverage for `mta-sts.<domain>`/`autoconfig.<domain>`, which is the first step of "a mail
  server that also speaks HTTP". That is a real scope boundary, which is why this is ranked
  last and flagged as a decision, not pre-approved. If built: opt-in, static responses
  only, no webserver ambitions ever (no proxying, no file serving). If declined: record it
  as an opinionated cut ("publish MTA-STS via any external static host" is a documented
  workaround — the policy file is two lines and can live anywhere that serves HTTPS).
- **Testing (if built):** policy fetch round-trip through our own MTA-STS *client* (we
  already have the fetcher — the server must satisfy its own enforcer), and a live
  Thunderbird account-creation walkthrough for autoconfig.

## Considered and rejected — with reasons

Per the working agreement, every omission is a recorded decision. HN demand alone does not
clear the bar; these were weighed and declined:

- **Spam filtering (Bayesian / reputation / DNSBLs).** The thread itself downplays the
  problem at personal scale (*"My spam folder currently contains 0 elements"* — kbmn;
  *"An overstated problem IMO"* — account42), and our DMARC enforcement already junks the
  forged class. A Bayesian filter is a large new subsystem with training UX. **Revisit
  trigger:** the box being used as a daily driver with observed, recorded spam volume that
  DMARC enforcement doesn't catch.
- **Webmail.** The mission is *existing clients* (Thunderbird, Apple Mail); Mox's own
  webmail is self-described as "still in early stages" and drew the thread's only aesthetic
  complaints. Building a mail *client* is a different project.
- **2FA / passkeys.** Mox's author states the blocker precisely: IMAP/SMTP clients and the
  SASL standards don't support it yet — *"clients (like thunderbird) would still have to
  implement it."* Nothing meaningful to build until the ecosystem moves. The per-IP
  throttle covers the brute-force class today.
- **JMAP, Sieve, CalDAV/CardDAV, POP3.** Reaffirmed cuts (ADR 0007 / roadmap). The demand
  exists in the thread; the mission — the modern-client round-trip, minimal-first — is
  already met without them. JMAP remains the recorded "desirable later, not minimum" item.
- **Backup MX / HA / clustering.** Personal scale; even Mox declines this (its author:
  a single server "for over a decade without issues"), and the thread's own experts note
  accept-then-forward backup MXes create backscatter obligations. B4's snapshot story is
  the honest availability answer at this scale.
- **Built-in ACME.** Genuinely attractive for the ten-minute-setup story, but a large
  zero-dep engineering effort (JOSE, account lifecycle, http-01 on port 80) duplicating
  certbot, which is ubiquitous and already documented. **Revisit trigger:** real evidence
  that cert provisioning is the setup step that defeats operators.
- **Greylisting.** Mox rejects it too (it poisons reputation-based reasoning and delays
  legitimate mail); nothing in the thread defends it.
- **Milter / plugin hooks / external filter integration.** Anti-mission: the project is
  self-contained and opinionated precisely to avoid integration-point complexity (Mox's
  author makes the same argument for one package).
- **Distro packaging / unattended updates.** The #1 wish of Mox *users* — but it
  presupposes a distribution story this project doesn't have yet and isn't seeking.
- **Prometheus metrics / structured log tooling.** Real Mox strengths, but at personal
  scale `doctor` (B2) + the queue CLI (B5) answer the actual operator questions; a metrics
  endpoint is infrastructure without a consumer here.

## Sequencing note

B1 + B2 are one natural increment (shared DNS/record plumbing; together they are the
"confidence" answer the evidence asks for). B3 stands alone and fixes a real wart. B4 and
B5 are small and independent. B6 waits for an explicit decision. As ever: each item lands
with its tests, its live verification where internet-facing, and its doc updates in the
same increment.
