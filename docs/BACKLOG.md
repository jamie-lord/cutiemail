# Backlog: open work, and what was deliberately declined

This is the one live list of what is **not yet done**. Every open item states its evidence and
a one-sentence, mission-rooted reason it matters, the bar the
[working agreement](WORKING-AGREEMENT.md) sets. Everything that was weighed and **declined** is
in the ledger below, each with its reason, so a cut is a recorded decision rather than a silent
gap. For what the server already does and how it's proven, see [TESTING.md](TESTING.md) and
[the decision records](decisions/0000-about-these-decisions.md).

A test-coverage audit (2026-07-21) worked through ~30 candidate gaps: ~25 became
reproduce-first, negative-controlled tests (the suite is now 1162 cases) and the rest are
recorded declines in the ledger below or new decision records (ADRs
[0021](decisions/0021-imap-mailbox-name-encoding.md),
[0022](decisions/0022-eai-smtputf8-scope.md),
[0023](decisions/0023-outbound-delivery-semantics.md)). The correctness / usability / security
queue is empty again but for the one follow-up below.

## Open: correctness follow-up

### rename-INBOX UIDVALIDITY monotonicity

A plain `CREATE` draws UIDVALIDITY from the catalog's monotonic high-water mark, so a
recreated name can never reuse a deleted incarnation's `(UIDVALIDITY, UID)` space (RFC 9051
§6.3.4). The one path that does not is the fresh target a `RENAME INBOX` produces: it is
seeded with **INBOX's own** UIDVALIDITY (the catalog origin), not a value pulled from the
counter (ADR 0016 fixed its mod-sequence and expunge-log semantics, not this). So `RENAME
INBOX A`, `DELETE A`, `RENAME INBOX A` again hands both `A` incarnations the same UIDVALIDITY,
and a client that cached the first could take the second's UIDs as unchanged. Narrow (it needs
a rename-onto-a-previously-deleted-name sequence, a rare operator/client action) and scoped for
a follow-up: draw the rename-INBOX target's UIDVALIDITY from the same monotonic counter, and
add it to the catalog-parity differential oracle.

## Open: test-bed completeness

The test suite is the one place where completeness is itself the goal, so these stay listed
even though each is either blocked on an environment or marginal against coverage already
achieved:

### Real-MTA (Postfix) calibration of the receiver suite: DONE (2026-07-22)

The SMTP receiver suite is now calibrated against **four** independent implementations (Postfix
3.7.11, Exim 4.99, mox 0.0.15, aiosmtpd 1.4.6) with zero false positives. Postfix ran via
Docker in two configs, vulnerable and hardened, and the suite flagged the two SMTP-smuggling
vectors on the vulnerable config and positively cleared them on the hardened one, the strongest
single validation of the false-positive discipline (which was built around never convicting a
hardened Postfix). It also gave the §4.1.2 control-octet rule a second lenient witness
(Postfix and aiosmtpd accept a BEL octet; Exim and mox reject it). No server change followed:
our server is on the strict side of all four. See
[reference-servers/CALIBRATION-postfix.md](../reference-servers/CALIBRATION-postfix.md).

Optional remaining corroboration: an OpenSMTPD or Stalwart/Maddy run. Not blocking; the
calibration goal is met four times over.

### openSPF RFC 7208 vector suite

SPF is implemented, wired, and tested, but the canonical ~200-case openspf.org YAML suite is
not yet vendored as a pinned oracle. Adopting it would exercise the macro and edge-case
boundary the evaluator currently treats as a deliberate safe non-match. Vendor as a frozen
snapshot with its licence.

### Longer Dovecot `imaptest` soak

The IMAP server was calibrated against `imaptest` (~12,000 mutations, five concurrent clients;
the run found and fixed a real RFC 9051 §7.4.1 bug). A longer soak needs a built `imaptest`,
which means compiling Dovecot from source; marginal against that cost, worth doing where a
prebuilt binary is available.

*Optional, not a gap:* continuous coverage-guided fuzzing. The parsers already have
deterministic fuzz harnesses (~30,000 generated inputs) plus per-subsystem security review; a
coverage-guided corpus would go deeper but is an addition, not a missing floor.

---

## Considered and declined, with reasons

Per the working agreement, every omission is a recorded decision. Popular demand alone does not
clear the bar. Most of these carry a revisit trigger.

**Scope cuts (ADR 0007, the opinionated boundary):**

- **POP3.** IMAP4rev2 serves every modern client; a whole extra protocol and harness for
  nothing gained.
- **JMAP.** Modern and desirable, but additive: the modern-client round-trip is
  already met. The standing "desirable later, not minimum" item.
- **Sieve.** Per-`+tag` folder filing would want it, but that filing is itself out of scope for
  now.
- **CalDAV / CardDAV / webmail.** Building a mail *client* or a calendar is a different
  project; the mission is serving *existing* clients.
- **DANE.** Needs DNSSEC validation Node's resolver doesn't provide; MTA-STS is the chosen
  outbound TLS-policy mechanism.
- **ARC sealing.** This server never forwards, so there is nothing to seal: inbound
  verification (ADR 0011) is the whole of the useful surface.

**Reporting and observability:**

- **DMARC `rua`/`ruf` and TLS-RPT emission.** Outbound scheduled-report machinery with near-zero
  value at personal scale; `ruf` is privacy-fraught besides.
- **Prometheus metrics / structured-log tooling.** `doctor` and the queue CLI answer the
  operator's real questions at this scale; a metrics endpoint has no consumer here.
- **Richer `account list` (created / last-login).** A marginal nicety. Its one real use,
  spotting a dormant or compromised account, would be better served by per-credential
  *last-used* on app passwords. **Revisit** alongside app-password observability.
- **ValiMail `arc_test_suite` as an external vector pin.** ARC's offline sign/verify
  round-trips plus the golden signing-input already cover the scope. Recorded nice-to-have.
- **A unified project-wide coverage percentage.** Rolling the receiver and outbound-client
  coverage into one number is cosmetic reporting, not correctness; it fails the bar.

**Operational:**

- **Live config / certificate reload.** SIGHUP is caught, logged, and ignored (rather than
  killing the daemon, Node's default); a renewed certificate is picked up by a restart, which
  clients reconnect from transparently. True hot-reload without dropping IMAP sessions means
  re-binding TLS contexts on live listeners. Real complexity. **Revisit** if
  certbot-restart churn or dropped IDLE sessions become a felt problem.
- **`account remove`.** Deliberately absent (ADR 0012): deleting the registry row would strand
  the mailbox database with all its mail, a half-destruction pretending to be clean. The CLI
  surfaces the decommission recipe (`disable`, then remove the mailbox file) instead.

**Infrastructure and availability:**

- **Serving the MTA-STS policy / client autoconfig over HTTP.** Decided: no HTTP listener
  (ADR 0013). The policy file is two lines and can live on any static host; `setup` emits it.
- **Built-in ACME.** Attractive for the ten-minute-setup story, but a large zero-dependency
  effort duplicating certbot, which is ubiquitous and documented. **Revisit** if certificate
  provisioning proves to be the setup step that actually defeats operators.
- **Backup MX / HA / clustering.** Personal scale; even Mox declines it, and
  accept-then-forward backup MXes create backscatter obligations. The `backup`/`verify`
  snapshot story is the honest availability answer here.
- **Distro packaging / unattended updates.** Presupposes a distribution story the project
  doesn't have and isn't seeking.
- **Multi-domain.** One domain per server is the current design (ADR 0009 notes a future
  multi-domain story would widen the account key, deliberately not now); multi-domain is
  a real scope expansion, revisitable with a stated reason.

**Security features blocked or covered elsewhere:**

- **2FA / passkeys.** Blocked on the ecosystem: IMAP/SMTP clients and the SASL mechanisms
  don't support them, so there is nothing to build until they move. The per-IP throttle covers
  brute force today; app passwords (ADR 0017) are the reachable adjacent win, and shipped.
- **Spam filtering (Bayesian / DNSBL / reputation).** DMARC enforcement already junks the
  forged class. A Bayesian filter is a large subsystem with training UX. **Revisit** trigger:
  daily-driver use with recorded spam volume that DMARC doesn't catch.
- **Greylisting.** Rejected: it delays legitimate mail and poisons reputation-based
  reasoning (Mox rejects it too).
- **Milter / plugin hooks / external filter integration.** Anti-mission: the project is
  self-contained and opinionated precisely to avoid integration-point complexity.

**Conformance depth and delivery (weighed in the 2026-07-21 coverage audit):**

- **Full EAI / SMTPUTF8 transmission.** Deferred, recorded as [ADR 0022](decisions/0022-eai-smtputf8-scope.md).
  The envelope is ASCII-only: submission and inbound reject a non-ASCII `MAIL FROM` / `RCPT TO`
  with `553 5.6.7` (SMTPUTF8 is not advertised), and the delivery client refuses to transmit an
  internationalized envelope rather than corrupt it. UTF-8 header/body content already parses;
  only the envelope is out of scope. **Revisit** if EAI submission is ever actually asked for.
- **DKIM key-record `h=` permitted-hash enforcement.** Declined: `sha1` is already rejected
  outright (RFC 8301), so honouring a key record that restricts the hash to a set adds no
  security over what the algorithm gate already denies.
- **Concurrent per-domain outbound relay.** Declined. The serial single-flight drain is
  deliberate: the `stop()` / DB-close safety design depends on there being one in-flight relay,
  and per-message host attempts are already bounded by the MX list. A concurrency rework
  (head-of-line elimination) exceeds the mission bar at personal scale; the queue drains fast
  enough that no message waits on an unrelated slow domain in practice.
- **Prompt permanent bounce for an IPv6-only destination.** An AAAA-only domain (no A, no MX)
  is not treated as deliverable, since relay is deliberately IPv4-only (PTR reasons). It stays a
  **transient** failure (the domain may add an A record) rather than a prompt permanent bounce.
  A prompt v6-only bounce is left as an operator deliverability-policy call, not a default.
- **`httpsFetchPolicy` timeout / redirect unit tests.** Declined as not cheaply unit-testable:
  exercising the timeout and no-redirect paths needs a live TLS server answering under the exact
  `mta-sts.<domain>` name. The non-200 and oversize-truncation paths *are* tested; the
  end-to-end enforce-mode delivery is covered by the MTA-STS integration suite.

*Previously open, since resolved (recorded so they aren't re-proposed):* dot-stuffing / DATA
transparency coverage (ADR 0005's revisit trigger fired; the receiving sink was built),
per-IP brute-force lockout (shipped as the auth throttle), and the STARTTLS-injection family
(ADR 0006: all three variants covered).
