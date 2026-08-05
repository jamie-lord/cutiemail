# 0025. Self-update: a separate updater, and a cutover that must earn the switch

## Status

Accepted. Implemented; automatic switching ships disabled (see below). Exercised end to end against
a real deployment, which changed the verification ladder — see
[the backlog](../BACKLOG.md#closed-what-a-live-self-update-test-found) for what it found and
[keeping a deployment up to date](../SELF-UPDATE.md) for how to run it.

## Context

Self-hosted software rots. An operator deploys it, it works, and then it sits — unpatched, adrift
from the internet around it — because nobody schedules the chore to update it. That failure mode is
the single most common way a homelab service becomes a liability. "The operator will remember" has
never been true.

cutiemail is unusually well placed to fix this for itself. There is no build step (Node runs the
`.ts` directly), no dependency tree to resolve, no artefact to publish: a version *is* a commit. It
already ships the two things a careful update needs and most projects lack. `selftest` proves the
whole mail path end to end against a running daemon. `backup` takes a consistent snapshot with
`VACUUM INTO`.

A mistake here is also unusually *dangerous*. A mail server that fails to restart does not merely
stop serving pages. Inbound mail bounces or defers, submission fails silently in clients, and the
operator often learns days later. An auto-updater that breaks the instance is worse than the rot it
prevents.

## Decision

### The updater is a separate program, and the daemon can never write its own code

The mail daemon is the internet-facing, attack-surface-rich part. If it can rewrite its own source,
any remote code execution in it becomes *persistent* — the attacker writes the next version. The
systemd unit is deliberately sandboxed (`systemd-analyze security` ≈ 1.6, read-only filesystem bar
the data directory). A self-rewriting daemon discards that.

So the updater is a separate entry point (`node src/update/main.ts`). A systemd timer runs it as its
own user, with write access to the version store and no ability to serve mail. The daemon keeps zero
write access to `/opt/mailserver`. This ADR corrects `deploy/hetzner-up.sh`'s `chown -R mail:mail`.

The updater necessarily uses `node:child_process` (to run a candidate and its tests) — the first use
anywhere in the tree. That is acceptable *because* it is not the mail server, and the zero-dependency
claim is about what answers port 25. This record states it here, so nobody later mistakes it for
erosion.

The same boundary runs the other way: **the updater ships code and never unit files.** Write access
to `/etc/systemd/system` would let it change `User=` and hand itself root. That would make every
other restriction here decorative, so the polkit rule grants exactly one unit and three verbs. The
cost is that the unit is configuration no update can correct. At least one of its settings is
load-bearing for the update mechanism itself: `TimeoutStopSec`. It must be at least the drain
deadline, or systemd kills first. The updater answers that by *reporting* rather than by widening the
grant. `check`, `apply` and `status` each name a stop budget that is too short, the setting that
fixes it, and the value to use. Detection is compatible with containment. Correction is not.

### Git, spoken in Node, with no `git` binary

The updater implements git's smart HTTP protocol v2 directly over `fetch`, `node:zlib` and
`node:crypto`. It uses `ls-refs` to learn where `main` points, `fetch` to pull a packfile, then
packfile and delta decoding, object verification, and a tree checkout. This is the same bet the rest
of the project makes about SMTP, IMAP, MIME and DKIM, and a packfile reader is simpler than the IMAP
server.
It keeps "requires git" off the deployment page and keeps the update path testable with byte-exact
fixtures like everything else.

### Trust: TLS to GitHub, stated plainly

The trust root is TLS to `github.com` plus GitHub's access control on the repository. There is no
release signing. This is a deliberate choice, not an oversight: a signature only adds security if the
key lives somewhere GitHub does not, which means an offline signing ceremony performed reliably
forever. A key in CI would be theatre. Instead, content addressing verifies everything *downstream*
of "GitHub told us the SHA".

The updater checks object SHAs (SHA-1, git's default). Node's `createHash` has no collision
detection, so this is integrity against corruption, not a security boundary — the security boundary
is TLS.

What this does **not** protect against, recorded so nobody assumes otherwise: a compromise of GitHub
or of a maintainer account can ship code to every deployment.

### Provenance: descendant-only, and old enough

Two rules, both enforced locally:

- **The candidate must be a descendant of the commit we are running.** The updater verifies this by
  a walk of commit parents in the fetched objects. This turns an *accidental* backwards move — a
  force-push that rewrites deployed history — into a *refusal* rather than a silent apply. So
  fix-forward is the only path that reaches deployments, which is the right discipline anyway. It is
  **not** a defence against a hostile server, and it does not make a malicious rollback impossible.
  Whoever can serve the bytes can ship code (the trust model above). The ancestry walk deliberately
  counts a named-but-absent parent as present, so a fabricated tip that merely names the running
  commit as a parent passes it. Repository access control, not this rule, is what stops a deliberate
  rollback.
- **The commit must be at least `bakeDays` old** (default 3), so a mistake merged to `main` has a
  window in which someone can notice and revert it before it reaches anyone.

A staleness alarm is the mirror image. The updater records every successful check. If it *cannot
check* for longer than a threshold, it surfaces that as a problem. Otherwise anyone who can block
access to GitHub pins a deployment on an old version forever, and nothing notices. It is the same
rot, which arrives through the mechanism meant to prevent it.

### The verification ladder

This is the heart of the decision. A candidate does not earn a switch merely because it exists. It
earns the switch only when it climbs every rung. Any failure at any rung abandons the update and
leaves the running version untouched.

The design principle is that **each rung is stronger evidence than the last, and the expensive rungs
run against a copy of real data rather than a fixture.** Most auto-updaters stop at "the process
started". That is the rung that proves the least.

**1. Provenance** — descendant of current, at least `bakeDays` old.

**2. Integrity** — every object hashes to its SHA. Every tree entry passes the checkout allow-list
(no `..`, no separators, no NUL, nothing matching `.git` case-insensitively, no symlink or gitlink
modes). Packfile size, object count, per-object inflated size, delta depth, the resolved-bytes
aggregate, and the checkout's file *and directory* counts are all bounded. A malformed pack is
"no update available", never a partial checkout.

**3. Shape** — the checkout contains what a cutiemail version must contain (`src/main.ts`,
`package.json` with a matching name, enough files and enough tests that a truncated tree cannot pass
with nothing to run). It is cheap, and it catches a wrong-repo or truncated fetch before anything
expensive runs. It also checks `engines.node` against the runtime that would execute it. "the new
version needs a Node this host does not have" is a classic way for an auto-updater to brick a
deployment. The failure arrives *after* the switch, as a syntax error from a feature the old
runtime cannot parse. A range we cannot evaluate is a refusal, not an assumption — a wrong guess
here is exactly the case that stops the service.

A defect in the updater that blocks updates is **self-perpetuating**. The deployment cannot pull the
fix, because the broken check refuses every candidate. That is the argument for the staleness alarm
as load-bearing rather than decorative. "updates are configured but not arriving" is the only signal
that will ever reach an operator in that state. It is also the argument for `check` mode to exist at
all, since a deployment that reports without switching still surfaces the problem.

**4. It runs on this machine** — the updater imports every module the candidate ships, one at a time,
in a subprocess with the Node that is actually installed. The report names the module that fails.

This rung used to run the candidate's entire test suite, and that was wrong on the merits and fatal
in practice. On the merits: rungs 1 and 2 already proved the checkout is byte-identical to a
commit CI tested. A re-run of deterministic tests re-answers a settled question — a sequence-set
parser cannot behave differently on a Hetzner box than on a laptop. In practice: on the two shared
cores `deploy/hetzner-up.sh` provisions by default, the suite does not finish inside fifteen minutes.
So **every update was refused, with a message that blamed the candidate.** Worse, the suite contains
wall-clock-sensitive cases that flake under contention. So the rung's most likely failure mode was
a refusal of a sound update, which teaches an operator that the safe setting is `off`.

What survives is the one thing that rung uniquely bought: whether this runtime can parse and
evaluate this code. `engines.node` in rung 3 checks a *declaration*, and a declaration is a claim
about a range, not evidence. A version that adopts a language feature the installed Node predates
satisfies every declared constraint and then dies at the first import after the switch.

It is a regression gate and *not* a security boundary: a hostile version would ship a tree that
imports cleanly. Provenance is what stops a hostile version.

**5. Boot in isolation, and conformance measured as a regression** — the candidate starts with a
synthetic config on ephemeral loopback ports and a scratch database, and answers on all three. That
separates "the new version is broken" from "your data or configuration is the problem", which rung 6
cannot do on its own.

The SMTP conformance corpus then runs against that listener — and against the *currently running*
version, booted the same way. The updater compares the two. **The gate is regression, not perfection.**
A conformance gap the running version already has is not a reason to refuse an update. A refusal
would pin the deployment forever on the very version that has the gap, and the operator would never
receive the fix. A gap the candidate *introduces* is a different matter and fails the rung. Without a
baseline the corpus can only report, and it says so rather than guess.

The updater treats a run in which every case returned inconclusive as a failure. Readiness measures
whether the ports accept connections. A listener that accepts and then says nothing is that
measurement's blind spot. It produces no findings, which the regression comparison would otherwise
read as "no new findings".

**6. Against a snapshot of *your* data — the rung that matters** — the updater takes `VACUUM INTO`
snapshots of `control.db` and every `mail-<login>.db`, and starts the candidate against **those
copies, with your real configuration**, on ephemeral loopback ports.

This happens in **two separate boots**, and the split is load-bearing. The first boot migrates, and
the updater measures it, and nothing else touches it. So the census afterwards can say *nothing
changed* — a claim impossible to make about a boot that also had to deliver mail, where a migration
that lost a message and a probe that added one are indistinguishable. The second boot does the work.

The first boot answers the questions that actually break deployments:

- does the candidate's schema migration succeed against your data, at your size?
- **how long does the migration take?** — measured here, because it is downtime later, and a
  ten-minute migration is something to know before you stop the service rather than after
- does your existing configuration still satisfy the new version, or did a new requirement appear?
- do the accounts, aliases, mailboxes, message counts, UIDVALIDITY values and stored message bytes
  all survive unchanged?
- **does the stored authentication material survive byte for byte?** This is the quietest
  catastrophe available. Nothing is deleted, no message moves, the server starts and reports itself
  healthy, and it permanently rejects every client. Because SCRAM stores a salted, iterated
  verifier, nobody can recover the passwords from what is left. Note the mail-path boot below does
  *not* cover it. That boot logs in with a credential the pre-flight minted moments earlier, which
  proves the auth algorithm works on a new verifier and says nothing about the ones your clients hold.

The updater also compares the measured migration time against the service unit's own
`TimeoutStartSec`, read from the unit rather than configured twice. A number on its own reads as
reassurance. The judgement that matters is whether the real cutover fits in the budget systemd will
actually allow. A migration that systemd kills half-way through happens on the live databases rather
than a copy.

Two corrections to that claim, both found by audit. It read the value with `Number()`, and systemd
renders every `*USec` property as a human timespan ("1min 30s") rather than an integer. So the parse
yielded `NaN`, `unitStartTimeoutMs` returned undefined on every real deployment, and the comparison
silently never ran. There is no machine-readable output mode for `systemctl show` to switch to, so
the updater now parses the timespan. And the value it reads is `MAIL_UPDATE_UNIT`'s — the daemon's —
which is correct in intent but weaker than it sounds. `mailserver.service` is `Type=simple`, so
systemd considers it started at `fork()`, and the start timeout does not actually bound the migration
that follows. The deadline that does bind is the cutover's own readiness timeout, after which it
reverts. The updater keeps the comparison because a migration approaching either number is worth
saying out loud, but it is a warning about growth, not a guarantee about a kill.

The second boot proves the mail path end to end against real data: authenticated submission, local
delivery and IMAP read-back, driven by `selftest` against a real account's real mailbox. Accounts
store SCRAM material, so nobody can recover an existing password. That is the right property, and it
means the updater mints an **app password inside the snapshot** to log in with. That is safe there
and only there. It is a copy, destroyed minutes later, and the live registry is untouched.

**The updater checks outbound signing separately, because local delivery never reaches the signer.**
The server signs a submitted message only on the copy bound for a remote domain. It stamps the local
copy with a `Received` trace and stores it unsigned. So the `selftest` probe above — which delivers
to the account itself — cannot see the signer at all. A candidate that stopped signing outright
passed every rung, cut over, and sent unsigned mail. Nothing downstream catches that: the probe
passes, the watch window passes, the daemon is entirely healthy, and the operator learns from DMARC
aggregate reports days after the updater confirmed the version. The rung therefore submits a second
message to a reserved remote domain and inspects the **queued** copy for a `DKIM-Signature` carrying
the expected domain and selector. Nothing is sent — the updater forces `MAIL_OUTBOUND=hold` for
every candidate boot.

That check needs a key, and the updater cannot read yours by design (see the containment argument
above — it is a different user precisely so a compromise of it is not a compromise of the mail). The
answer is a **stand-in**, not a skip. Unreadable key material used to delete the variable, which
moved the candidate onto a different branch. That branch used the bundled dev certificate rather than
a file read, and no signer at all rather than a signer. So the production path went untested in
exactly the two places most likely to break mail. A written-out certificate and a generated DKIM key
exercise the same code with material of the same shape. The reduction in fidelity that remains is
real, narrow, and reported: whether the operator's own key files parse, which an update does not
affect.

**Readiness means the ports accept connections, in the cutover as well as the pre-flight.**
`systemctl start` returns when systemd considers a `Type=simple` unit started — the moment its
process is forked, not the moment it serves. On a real box the gap is around 460 ms for an idle
deployment, and it is exactly the work rung 6a measures: it opens the databases, applies any
migration, and binds three ports. A probe issued inside that window reports "could not connect to the
submission port" about a daemon that is running perfectly well, and the cutover reverts a good update.
The probe therefore waits for the ports, generously, because the migration it waits through is the
one that scales with your mailbox. A bound that is merely usually-enough turns a slow migration into
a spurious revert, and spurious reverts are what teach an operator to disable updates. The updater
reports not-listening as its own outcome, because "the process is up and has not begun serving" and
"the mail path is broken" call for opposite responses.

**Only one run at a time.** Every run begins with recovery of an interrupted cutover, and no process
can tell another's legitimate in-progress switch from a crashed one. So a second run reverts the
first. systemd already prevents two instances of the update unit. The store's own lock covers
everything else (a hand-run command during a timer tick, a stray second timer). `status` is exempt:
it is read-only, and an operator who diagnoses a stuck run is exactly who needs it.

**What access the updater needs, and why it is not more than it looks.** The updater runs as its own
user precisely so that a compromise of the internet-facing daemon cannot rewrite the code that runs
next. That separation is one-directional: the updater still needs the *data*. It reads every
database to snapshot them, and it **writes** the control database, because the cutover probe mints
an app password immediately before the check and revokes it immediately after. A real message
through authenticated submission confirms the update, not the fact that the process is up. On a
deployment where the daemon creates its files 0600, group membership alone does not deliver that.
A POSIX ACL with a default entry does, and it survives the daemon's umask without widening it. A
mistake here does not fail loudly at install time — it fails at the probe, months later, and reverts.

**6c. Can we get back?** — the updater boots the version that is *currently running* against the
snapshot the candidate has just migrated. If it cannot open the snapshot, the update is one-way, and
the updater refuses it, unless `MAIL_UPDATE_ALLOW_IRREVERSIBLE=yes` says otherwise.

This is the rung the ladder was missing, and everything else leans on it. The pre-flight cannot test
the systemd sandbox: it spawns the candidate itself, so `ProtectSystem`, `SystemCallFilter`, the
capability bounding set and `ReadWritePaths` are all absent. The **cutover** can and does — it
restarts the real unit and then pushes a real message through the real ports — and its answer to a
failure is to rename the symlink back. So a working revert covers the sandbox, and every
environmental difference nobody has thought of. That makes revert the load-bearing guarantee of the
whole design. It is also what makes the drop of the test suite in rung 4 a sound trade rather than a
concession. Correctness-confidence and recoverability are substitutes, and this buys the cheaper one.

And revert only restores the *code*. If the migration moved the data to a schema the running
version cannot read, a rename of the symlink back produces a dead server. Then the only way home is
to restore the pre-cutover snapshot by hand, during whatever incident prompted the revert. You cannot
infer this from a schema version number — a number that goes up says nothing about whether the
old code can still read what is there. The old binary either opens it or it does not.

Three safety rules are absolute here, because this rung runs a downloaded program with production
configuration:

- **The updater rewrites every account's mail-database path in the snapshot to point inside it.** The
  control database stores an absolute path per account, so a verbatim copy still names the *live*
  mailbox files. A candidate booted against it would open, migrate and write real mail while it
  believed it ran against a copy. The rewrite is what makes a copy a copy. If any account still
  points outside the snapshot afterwards, the updater refuses it outright.
- **The updater forces `MAIL_OUTBOUND=hold`.** The snapshot contains the outbound queue. A candidate
  booted against it in `deliver` mode would relay every queued message a second time. This is the
  single most dangerous thing about a test with real data, and it is why hold mode is a hard override
  rather than a default. The census is what turns that from an assertion into evidence. It digests
  each queued message's remaining recipients, attempt count and next-attempt time. So the census
  catches a relay tick that ran and *failed* — one that left the row in place, merely rescheduled —
  just as surely as one that succeeded. A depth comparison alone would miss it entirely.
- **Loopback-only, ephemeral ports.** The candidate never binds 25, 587 or 993, and is never
  reachable from off the machine. The updater overrides the bind address rather than inherit it,
  because a real deployment's is public.

The updater strips `MAIL_UPDATE_*` from the candidate's environment: a program still under judgement
has no business to reach the network and rewrite the version store that decides its fate.

The updater hashes stored message bytes in full below half a gigabyte, and fingerprints them by
length plus their first and last 8 KiB above it. The report says which. A service timeout kills a
pre-flight that takes twenty minutes, and an update that never completes is the rot this exists to
prevent.

One honest limitation: in a correct deployment the updater is a different user from the daemon and
the TLS key is `0600`, so the check usually cannot read the real certificate and uses the bundled
loopback-only development one instead. That is a real reduction in fidelity, and the report states it
plainly rather than hides it.

The updater destroys the snapshots afterwards, whatever the outcome.

**7. Cutover preconditions** — a fresh snapshot exists and passes `verify`, there is disk space to
revert, and the drain (below) completed within its deadline.

**8. Post-cutover probe** — after the switch, the new instance must prove itself *live*: a real
message through authenticated submission on the real port, delivered, read back over IMAP, and
deleted. Anything short of that would miss a version that binds its ports and then fails on every
message. The probe credential is an app password, minted immediately before and revoked immediately
after, so there is no standing password anywhere. This is not a new privilege for the updater, which
already holds database access in order to take snapshots at all. But a credential that exists for
ninety seconds is a smaller thing to lose than one that exists forever.

**9. Confirmation** — only after the probe window passes without incident does the updater mark the
new version good, and older versions become eligible for pruning. "It started" is not confirmation.

### The cutover: drained, reversible, and crash-safe

**Drain before switch.** The updater asks the running daemon to stop accepting work and finish what
it has: `SmtpReceiver.close()` already awaits in-flight handlers and `relayLoop.stop()` already awaits
the current tick, so "not busy" has a real definition rather than a guess — no message part-way
through DATA, no relay tick mid-delivery. IMAP sessions get `* BYE` so clients reconnect cleanly
rather than see a dropped socket. If the drain does not complete within its deadline, the cutover
is **abandoned**, not forced: the update can wait, but an interrupted delivery cannot be undone.

**An explicit state machine, written to disk atomically.** `IDLE → FETCHED → VERIFIED → SNAPSHOTTED →
DRAINING → SWITCHING → PROBING → CONFIRMED`, with `REVERTING` reachable from the last three. Each
transition is a write-temp-and-rename, so a power cut mid-cutover leaves a state the next run can
recover from deterministically rather than an ambiguous half-switched tree.

**Automatic revert.** If the probe fails, or the new version stops running inside the watchdog
window, the updater flips the symlink back and restarts. If the candidate's migration moved the
schema forward, the updater restores the pre-cutover snapshot, because an older binary cannot safely
read a newer database. A flip of the symlink alone would leave a version that cannot start at all.

**A revert never deletes.** A restore costs whatever arrived between the snapshot and the failure —
usually nothing, because the service is down for most of that window — but it is a real cost. So the
failed version's databases are MOVED ASIDE rather than removed, and the updater tells the operator where.

The write-ahead log is the trap, and it cuts both ways. A copy of a snapshot over a live database,
while a `-wal` sidecar remains, makes SQLite replay those frames on the next open. It resurrects state
the snapshot never held, so the sidecars of the file under *replacement* must go. But a WAL database is
three files, and for a while the updater moved aside only the main one, while the sidecars kept their
original name and it then unlinked them with everything else. So SQLite silently rolled the preserved
copy back to its last checkpoint, and what it lost was mail the server already answered `250` for. The
window is not exotic: `systemctl stop` SIGKILLs at `TimeoutStopSec`, so a hot WAL at this moment is
the normal case. The sidecars now travel with the database they belong to.

**Recovery always leaves the mail server running.** Which phase was interrupted decides which
*version* runs. It must never decide whether anything runs at all, and a recovery path that quietly
leaves the service down is the worst possible outcome of a mechanism whose entire purpose is
availability. That is one rule applied after the phase-specific handling, not a branch in each case.

**Schema versions make that decidable.** Both database kinds carry `PRAGMA user_version`. Every build
declares the version it writes and the minimum it can read, and refuses to open a database from the
future rather than misbehaving against it. Without this, rollback is a guess.

### Reporting by default at first, then switching

`MAIL_UPDATE_MODE` defaults to `check`: the updater fetches, climbs the whole ladder, and reports —
but never switches. `apply` is available by hand from the first day, and a change of the mode to
`apply` hands the timer the keys. `off` pins a deployment entirely, including a hand-run `apply`.

The default is `check` rather than `off` because the *reporting* is worth having immediately and
carries no risk: it is what makes the staleness alarm meaningful, and a deployment that silently
does not check is the failure this whole mechanism exists to prevent. What waits for trust is the
switching, and the intent is to default that on once it has earned it — that flip is its own
decision, not this one.

## Consequences

- A deployment left alone stays current, which is the whole point.
- The strongest gate is rung 6, and it is only possible because `backup`, `selftest` and the
  conformance suite already exist. Their value was never only the thing they were built for.
- An update can be *refused* for reasons that look like inconvenience — the drain did not finish, the
  commit is too fresh, the migration takes too long, disk is short. A refusal is always correct: the
  running version already works.
- The updater becomes the project's most security-critical component, and the first that parses
  attacker-influenceable binary data and then writes files from it. It is treated like every other
  parser here: bounded, fuzzed, and mutation-tested, with negative controls for each refusal —
  a `..` in a tree entry, a symlink escape, a `.git` path, a bad object SHA, a non-terminating delta
  chain, a decompression bomb, a pack whose resolved objects exceed the aggregate byte cap, a tree
  of more directories than the checkout allows. **A gate never shown to fail does not count as a gate**, and that
  applies with more force here than anywhere: a pre-flight that silently always passes converts
  "it updates itself" from a safeguard into a false assurance.
- To update is not the same as to stay healthy. Node at EOL, OS packages, certificate renewal and
  provider policy changes are outside what this can fix. `doctor` remains the answer there. The
  documentation must not imply otherwise.
