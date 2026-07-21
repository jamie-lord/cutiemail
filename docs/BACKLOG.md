# Backlog — the single queue of open work

*Rewritten 2026-07-19. This is the one live list of what is **not yet done**. Every item
below has cleared the [working agreement's bar](WORKING-AGREEMENT.md): a one-sentence,
mission-rooted reason why it matters. Everything that was weighed and **declined** is in the
ledger at the bottom, each with its reason — so a cut is a recorded decision, not a silent
gap. What has already shipped is not re-listed here; it is a pointer, below.*

## What's already done (not repeated below)

Two whole bodies of work are complete and live-verified, so they are out of this queue:

- **The protocol/test map** — every tier of [TESTING-ROADMAP.md](TESTING-ROADMAP.md) is DONE:
  full send + receive with real clients (Thunderbird + Apple Mail), complete IMAP4rev2,
  SPF/DKIM/DMARC/ARC inbound + DKIM/SPF/DMARC outbound with enforcement, SQLite storage with
  crash/concurrency proofs, the outbound queue + bounces. Deployed on the box.
- **The operator-experience backlog (former B1–B6)** — the `setup`/`doctor`/`account`/
  `backup`/`verify`/`queue` operator CLI (`src/ops/`), plus [ADR 0012](decisions/0012-account-provisioning-cli.md)
  (registry-owned accounts) and [ADR 0013](decisions/0013-no-http-listener.md) (no HTTP
  listener). Evidence is in the commit messages (`git log --grep "(B[1-6]"`).

Beyond those, a sweep of production-readiness and parked-security work shipped together:
aliases + `+tag` subaddressing ([ADR 0014](decisions/0014-aliases-and-subaddressing.md));
**send-as / submission sender-authorization** ([ADR 0015](decisions/0015-submission-sender-authorization.md),
closing the cross-account spoof); **DKIM From oversigning** against prepended-From replay
(one shared RFC 6376 §5.4.2 header selector for DKIM + ARC); **INBOX-rename fresh-target
semantics** with a catalog-level differential oracle ([ADR 0016](decisions/0016-rename-inbox-fresh-target.md),
closing the run-8 QRESYNC residual); an **8-character password floor**; and **app-specific
passwords** ([ADR 0017](decisions/0017-app-specific-passwords.md)). Plus eight security-audit
runs + two live pentest sessions that converged (find rate 8→6→7→7→4→5→4→0).

A **ten-persona UX pressure test** (simulated new users, from a nervous first-timer to a
15-year Postfix admin, each running the project hands-on before open-sourcing) then drove one
more sweep — the getting-started and configuration experience, not the protocols. It found one
correctness blocker and a set of observability/usability gaps, all now shipped: the **submission
black hole** (mail to an unresolvable local address was accepted `250` then silently dropped —
now refused `550 5.1.1` at RCPT and re-validated atomically at delivery); a full **operational
log trail** (accepted messages, relay deferrals, and — the biggest gap — failed authentication
with source IP, the raw material for fail2ban); **boot-UX** fixes (absolute DB path in the
banner, a cert-expiry warning, a loud dev-cert-override warning, SIGHUP survives); the
conformance runner **no longer exits 0 against an unreachable target**; `queue retry`/`cancel`
and a read-only `mail list`/`show`; the `:memory:` honesty fix; `MAIL_OUTBOUND=hold` for a
dev/test sink ([ADR 0020](decisions/0020-outbound-hold-mode.md)); and the doc rewrites the
personas' confusion pointed to (migration, restore, cutover, positioning). Suite 1063.

## How an item earns its place here

Ordered by value. Each states its evidence, its one-sentence mission fit, its shape, and how
it will be tested — the four-part discipline the working agreement requires. An item that
can't fill in all four isn't on the list; it's in the ledger.

---

## Open work

The correctness/usability/security queue is **empty** — items 1–5 shipped (see the pointer
above). What remains is test-bed completeness, all either environment-blocked or marginal
against coverage already achieved.

## Test-bed completeness — recorded, lower priority

The test suite is the one place completeness is the goal, so these stay listed — but each is
either environment-blocked or marginal against coverage already achieved.

### 6. Real-MTA (Postfix) calibration #23/#24 — *environment-blocked*

- The SMTP receiver suite is calibrated against **three** independent implementations already —
  Exim 4.99, mox 0.0.15, aiosmtpd 1.4.6 — zero false positives, with the bare-LF finding
  confirmed real across all three. Postfix is the recorded 4th target, blocked here by Docker
  registry egress (diagnosis in `reference-servers/README.md`); native Postfix needs root and
  would disturb host mail. Do it on a root-capable / working-Docker host; the harness runs
  unchanged. Marginal value — a 4th permissive-or-hardened MTA mostly re-confirms.

### 7. openSPF RFC 7208 vector suite adoption — *low; strengthens a real surface*

- SPF is implemented and wired (`src/auth/spf-check.ts`), but the canonical ~200-case
  open-spf.org YAML suite isn't yet vendored as a pinned oracle. Adopting it would exercise the
  macro / edge-case boundary we currently treat as a deliberate safe non-match. Vendor as a
  frozen snapshot (BSD-style licence, HTTP-only host — noted in the mail-server memory).

### 8. Longer Dovecot `imaptest` soak — *environment-blocked*

- The IMAP server was calibrated against `imaptest` (~12k mutations, which found + fixed a real
  RFC 9051 §7.4.1 renumbering bug). A longer soak needs a fresh Dovecot-2.3.21 source compile
  (no Homebrew formula; Docker egress broken here). Marginal against the build cost; do it where
  a prebuilt `imaptest` is available.

*Optional, not a gap:* continuous coverage-guided fuzzing. The parsers (SMTP/MIME/IMAP/address)
already have deterministic fuzz harnesses (~30k adversarial inputs) plus the audit sweeps; a
coverage-guided corpus would go deeper but is an addition, not a missing floor.

---

## Considered and not on the queue — with reasons

Per the working agreement, every omission is a recorded decision. HN/feature demand alone does
not clear the bar. These were weighed and declined; most carry a revisit trigger.

**Scope cuts (ADR 0007 — the opinionated boundary):**

- **POP3.** IMAP4rev2 serves every modern client; a whole extra protocol + harness for nothing gained.
- **JMAP.** Genuinely modern and desirable, but additive — the modern-client round-trip is already met. The standing "desirable later, not minimum" item.
- **Sieve.** Deferred later tier; per-`+tag` folder filing would want it, but that filing is itself out of scope now.
- **CalDAV / CardDAV / webmail.** Building a mail *client* or a calendar is a different project; the mission is *existing* clients.
- **DANE.** Needs DNSSEC validation Node's resolver doesn't provide; MTA-STS is the chosen outbound TLS-policy mechanism.
- **ARC sealing.** We never forward, so there is nothing to seal — inbound ARC verification (ADR 0011) is the whole of the useful surface.

**Reporting / operational cuts:**

- **DMARC `rua`/`ruf` + TLS-RPT emission.** Outbound scheduled-report machinery, ~zero value at personal scale; `ruf` is privacy-fraught.
- **Prometheus metrics / structured-log tooling.** `doctor` + the queue CLI answer the operator's real questions at this scale; a metrics endpoint has no consumer here.
- **Richer `account list` (created / last-login).** A marginal nicety with no correctness or security payoff. Its one real use — spotting a dormant/compromised account — is thin at personal scale. **Revisit** if app-passwords (item 5) land: a per-credential *last-used* is worth more than a per-account one, and would ride along.
- **ValiMail `arc_test_suite` external vector pin.** ARC's offline sign/verify round-trips + a golden signing-input already cover the scope; an external pin is marginal. Recorded nice-to-have.
- **Unified project-wide coverage percentage (ADR 0008).** Rolling the outbound-client and receiver coverage into one number is cosmetic reporting, not correctness — fails the bar.

**Operational cuts (recorded during the UX pressure test):**

- **Live config / certificate reload.** SIGHUP is caught, logged, and ignored (rather than
  killing the daemon, Node's default); a renewed cert or changed config is picked up by a
  restart, which clients reconnect from transparently. A true hot-reload that re-reads
  `MAIL_TLS_CERT`/`MAIL_TLS_KEY` on SIGHUP without dropping IMAP sessions is a real feature with
  real complexity (re-binding TLS contexts on live listeners). **Revisit** if certbot-restart
  churn or dropped IDLE sessions become a felt problem.
- **`account remove` verb.** Deliberately absent (ADR 0012): deleting the registry row would
  strand the mailbox database with all its mail — a half-destruction pretending to be clean. The
  CLI now surfaces the decommission recipe (`disable`, then `rm` the mailbox file) instead of a
  bare usage error, so the decision is discoverable, not a gap.

**Infrastructure / availability cuts:**

- **MTA-STS policy publication + client autoconfig (former B6, ADR 0013).** Decided: no HTTP listener. The policy file is two lines and can live on any external static host; `setup` emits it. Revisit trigger recorded in ADR 0013.
- **Built-in ACME.** Attractive for the ten-minute-setup story, but a large zero-dep effort duplicating certbot, which is ubiquitous and documented. **Revisit** if cert provisioning proves to be the setup step that defeats operators.
- **Backup MX / HA / clustering.** Personal scale; even Mox declines it, and accept-then-forward backup MXes create backscatter obligations. The `backup`/`verify` snapshot story is the honest availability answer here.
- **Distro packaging / unattended updates.** Presupposes a distribution story the project doesn't have yet and isn't seeking.
- **Multi-domain.** ADR 0009 fixes one domain per server as the minimum; a multi-domain story is a real scope expansion, revisitable with a stated reason, not a queued item.

**Security features blocked or covered elsewhere:**

- **2FA / passkeys.** Blocked on the ecosystem: IMAP/SMTP clients and the SASL mechanisms don't support it, so there is nothing to build until they move. The per-IP throttle covers the brute-force class today; app-passwords (item 5) are the reachable adjacent win.
- **Spam filtering (Bayesian / DNSBL / reputation).** DMARC enforcement already junks the forged class, and the problem is downplayed at personal scale. A Bayesian filter is a large subsystem with training UX. **Revisit** trigger: the box used as a daily driver with recorded spam volume DMARC doesn't catch.
- **Greylisting.** Rejected — it poisons reputation-based reasoning and delays legitimate mail (Mox rejects it too).
- **Milter / plugin hooks / external filter integration.** Anti-mission: the project is self-contained and opinionated precisely to avoid integration-point complexity.

*Already resolved (here for the record, so they aren't re-proposed):* dot-stuffing / DATA
transparency (ADR 0005's revisit trigger fired — the receiving sink was built and R-5321-4.5.2-c
is covered), per-IP brute-force lockout (ADR 0009's "later nice-to-have" — the throttle shipped),
and the full STARTTLS-injection family (ADR 0006 — all three variants covered).
