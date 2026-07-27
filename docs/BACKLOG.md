# Backlog: open work, and what was deliberately declined

This is the one live list of what is **not yet done**. Every open item states its evidence and
a one-sentence, mission-rooted reason it matters, the bar the
[working agreement](WORKING-AGREEMENT.md) sets. Everything that was weighed and **declined** is
in the ledger below, each with its reason, so a cut is a recorded decision rather than a silent
gap. For what the server already does and how it's proven, see [TESTING.md](TESTING.md) and
[the decision records](decisions/0000-about-these-decisions.md).

A test-coverage audit (2026-07-21) worked through ~30 candidate gaps: ~25 became
reproduce-first, negative-controlled tests (the suite stood at 1162 cases after that audit) and the rest are
recorded declines in the ledger below or new decision records (ADRs
[0021](decisions/0021-imap-mailbox-name-encoding.md),
[0022](decisions/0022-eai-smtputf8-scope.md),
[0023](decisions/0023-outbound-delivery-semantics.md)). The correctness / usability / security
queue is empty again but for the follow-ups below.

## Closed: the conformance gaps found by the register expansion

A register-and-test pass (2026-07-26) took the IMAP register from 21 requirements to 66, the
crypto register from 23 to 40, and pointed the SMTP conformance corpus at this project's own
inbound listener for the first time. Ten MUST/SHOULD-level findings came out of it. Each was
written first as a running test marked as a known gap, so the obligation stayed executable while
it was open; all ten are now resolved and the suite carries no gap markers.

| # | Requirement | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | RFC 9051 §6.3.6 | `RENAME` did not move inferior hierarchical names. Renaming `foo` to `baz` left `foo/bar` unreachable under either name, orphaning the mailbox and the mail in it. Shaped like data loss, and the most serious of the ten. | Fixed. `subtreeRenames` in `store/mailbox-name.ts` is shared by both catalogs, so the reference and the real store cannot drift. A destination collision anywhere in the subtree refuses the whole rename, and INBOX's own inferior names stay put, as §6.3.6 requires. |
| 2 | RFC 9051 §6.2.2 | An invalid base64 response to `AUTHENTICATE` drew `NO [AUTHENTICATIONFAILED]` where the RFC requires a tagged `BAD`. `NO` sends a client back to the user for a new password; `BAD` tells it its own encoding is broken. A client with a SASL bug was put in a re-prompt loop against a user whose password was fine. | Fixed on both the continuation and the RFC 4959 initial-response path. Node's base64 decoder is the reason this needed an explicit gate: it skips characters outside the alphabet and stops at the first `=`, so garbage decoded to a short buffer and failed the credential check instead. |
| 3 | RFC 9051 §6.3.9 | `LIST` accepted an unrecognised `RETURN` option instead of answering `BAD`. The neighbouring rule pulls the other way: an unmatched PATTERN must be silently ignored and still return `OK`. | Fixed, and it needed a real parser: the option groups were read as single space-split tokens, so `LIST (SUBSCRIBED RECURSIVEMATCH) "" *` had already been silently mangling its own pattern. `RETURN (STATUS …)` is now answered rather than ignored, since §6.3.9 also requires the options the document defines to be supported. |
| 4 | RFC 6376 §6.1.1 | A DKIM signature with `v=2` verified instead of returning PERMFAIL (incompatible version). | Fixed in the signature parser, where §6.1.1 puts the "meticulously validate" obligation. |
| 5 | RFC 6376 §6.1.1 | `a=rsa-sha999` verified: `a=` was read by suffix, so anything not ending `sha1` was treated as SHA-256. Signer and verifier disagreed about what was computed. | Fixed with a closed algorithm set. `rsa-sha1` stays in it deliberately — RFC 8301 refuses it as a cryptographic *failure*, which is a different answer from a syntax error. |
| 6 | RFC 6376 §6.1.2 | Recorded as a defect; it was not one. The key-record parser already refuses a `v=` that is not `DKIM1`, so the key side of the version rule was in place while the signature side (#4) was missing. | No change. The case is kept as the pin and widened to cover a version that is known but not first. |
| 7 | RFC 7208 §5.2 | An `include` whose recursive evaluation returned permerror was treated as "not match". Also how the ten-lookup limit was escaped: blow the shared budget inside an included record, the error is discarded, and evaluation continues. `temperror` propagated; `permerror` and `none` did not. | Fixed by implementing the §5.2 result table in full. The redirect sibling in §6.1 was wrong the same way and is fixed with it, now registered as R-7208-6.1-a. |
| 8 | RFC 7208 §4.6.4 | An `mx` mechanism whose MX record named more than ten hosts was evaluated in full rather than producing a permerror. | Fixed, and the same code was wrong in the opposite direction too: the MX-target address lookups were charged to the ten-*term* budget, which §4.6.4 puts them "in addition to". A legitimate domain publishing ten MX hosts and the record `v=spf1 mx -all` was handed a permerror it had not earned — and the over-wide case only produced the right answer because the term budget ran out first. |
| 9 | RFC 8461 §3.2 | An MTA-STS policy omitting `max_age` parsed as valid, so it had no defined lifetime. | Fixed at the parse, where a caller reading `.valid` can no longer act on it. The cache already declined to store such a policy, so nothing downstream changed. |
| 10 | RFC 8461 §3.1 | Not a defect: the resolver already refuses a TXT record whose version field is not first. | No change. The case exists because nothing pinned it and the natural "tolerant parser" change would remove the check silently. |

Three of the eight real defects (4, 5, 7) are the shape the security audits keep finding: **a guard
applied to one path and not its structural sibling.** Two more were only found because a test
harness was rebuilt — the DKIM cases originally edited an already-signed message, which invalidates
the signature, so "must not pass" passed for the wrong reason and proved nothing.

Every fix was verified by mutation: thirteen mutants across the eight defects, each breaking one
guard and each killed by the test that names the requirement, with every file restored byte-exactly
afterwards. Two of the thirteen exist only because a passing test can pass for the wrong reason —
one lifts the `mx` cap and one puts the address lookups back on the term budget, and the original
case would have survived the second.

## Closed: what a live self-update test found

The self-update system (ADR 0025) was exercised against a real Hetzner box for the first time.
Every rung of the ladder had passed in local rehearsal; the box found **nine defects**, none of
which local testing could have found, because each was a property of the machine rather than of
the code.

| # | Defect | Why only a real deployment finds it |
| --- | --- | --- |
| 1 | The smart-HTTP client refused every real git server: it expected the v2 advertisement to begin `version 2`, and GitHub, GitLab and Codeberg all prefix it with the `# service=` banner. | The in-repo fake server had been written from the same reading of the spec as the client, so the two agreed with each other and not with reality. |
| 2 | The daemon exited 0 silently when started through the `current` symlink — `import.meta.url` resolves symlinks, `process.argv[1]` does not. | ADR 0025's whole layout runs the daemon through that symlink. A flat checkout never hits it. |
| 3 | `hetzner-up.sh` hung forever waiting for cloud-init: `cloud-init status` exits 2 when it finishes *degraded*, and under `set -o pipefail` that exit code replaced the `grep`'s success. | Needs a real cloud-init, and a cloud-config with a schema slip to make it degrade. |
| 4 | Rung 4 ran the candidate's whole test suite, which does not finish inside its fifteen-minute cap on two shared cores — so every update was refused, blaming the candidate. | The suite takes ~110s on a developer machine. Only the target hardware shows it. |
| 5 | The updater could not read the databases it exists to snapshot. | Requires the real two-user deployment; a developer runs both halves as themselves. |
| 6 | A WAL database is three files, and only the one with the name was being secured. The sidecars are recreated at every checkpoint, so they reverted to owner-only and refused every reader the main file admitted. | Needs a live database being checkpointed by a running daemon. |
| 7 | The post-cutover probe ran before the daemon was listening, so every cutover reverted a good version. `systemctl start` returns when a `Type=simple` process has *forked*, not when it serves; the gap measured 459ms on this box. | A local rehearsal starts the candidate and waits for its ports; only systemd reports success this early. |
| 8 | No lock on the version store. A hand-run `apply` during a timer tick reverted a cutover that had already switched and passed its probe, because every run begins by *recovering* an interrupted cutover and cannot tell another process's legitimate in-progress switch from a crashed one. | Needs a timer firing on its own schedule alongside an operator. |
| 9 | A failed start was waited out for the full 120-second probe window before being called a failure, when systemd already knew the unit was dead. | Only shows up as wasted downtime on a real cutover. |

The failure paths were then exercised deliberately, on side branches so `main` stayed clean:

| Drill | Result |
| --- | --- |
| A module the installed runtime cannot parse | Refused at rung 4 in 325ms, naming the module. Nothing started, nothing switched. |
| Submission AUTH broken for every login | Refused at rung 6b, against a snapshot of real data — before the switch, so no revert was needed. |
| A version that dies under the unit's sandbox (writes outside `ReadWritePaths`) | Passed **every** pre-flight rung, because the pre-flight spawns the candidate itself and there is no sandbox there. Caught by the live probe after the switch and reverted. |
| `SIGKILL` in the instant between the symlink move and the restart | The next run broke the stale lock, read the recorded phase, reverted the version nothing had confirmed, and left the daemon serving. The timer applied the update again on its next tick. |
| A hand-run `apply` during a timer tick | Declined, naming the holding pid and stating that nothing was changed. `status` still answered. |
| Three consecutive unattended cutovers, then an idle soak | Each switched on its own; the soak reported "up to date" repeatedly with no churn. |

The sandbox drill is the one that matters, and it is the argument for the design: the pre-flight
cannot test the environment the daemon will actually run in, the cutover can, and its answer to a
failure is to rename the symlink back. Mail was intact after every drill — the same ten messages
throughout, a fresh delivery accepted after each, and no probe credential left behind.

Defect 4 changed the design rather than just the code. The rule that came out of it is **a
pre-flight check must be able to fail for a reason CI could not have caught**: rungs 1 and 2 already
prove the checkout is byte-identical to a commit CI tested, so re-running deterministic tests
re-answers a settled question, and on two shared cores they could not finish inside their cap. What
the box uniquely knows is this runtime, this configuration, this data, and this old→new transition,
so the rung became "every module imports under the Node actually installed" (487ms, from a 900s
cap). Dropping the suite is affordable because correctness-confidence and recoverability are
substitutes — which is why the same change added the rung that boots the *running* version against
the migrated snapshot, rather than inferring reversibility from a schema version number. The whole
ladder now finishes in ~43 seconds on the smallest box the project targets, which is the point: the
same assurance for a deployment that cannot afford to run a test suite.

Two properties worth carrying forward:

- **An updater defect that blocks updates is self-perpetuating.** The deployment cannot pull its own
  fix, because the broken check refuses every candidate. It bit three times during this exercise and
  each time needed a manual re-lay. That is what makes the staleness alarm load-bearing rather than
  decorative, and it is the argument for `check` mode existing at all.
- **Verifying the thing you changed is not verifying the thing that failed.** Defects 5 and 6 were
  each "fixed" and confirmed on the box before being found still broken — because the confirmation
  looked at the file that had been edited rather than at the operation that was failing. `test -r`
  on a database whose sidecars are unreadable says readable.

## Open: MTA-STS policy without an `mx` list

RFC 8461 §3.2's policy ABNF marks `sts-policy-mx` "required at least once, except when mode is
'none'". A policy that omits it currently parses as valid, and an `enforce` policy with an empty MX
list then refuses **every** host — all mail to that domain stops. Noticed while fixing the `max_age`
rule in the same ABNF and left as its own item rather than folded in silently: it wants a register
entry, a test, and a decision about which way to fail, since treating the policy as absent is a
downgrade to opportunistic TLS for a domain that meant to enforce.

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
- **Distro packaging.** A `.deb`/`.rpm` presupposes a distribution story the project doesn't have
  and isn't seeking. Unattended updates were the part of this worth having, and they are built
  instead as a self-updater over the git remote the deployment was installed from (ADR 0025), which
  needs no packaging story at all.
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
