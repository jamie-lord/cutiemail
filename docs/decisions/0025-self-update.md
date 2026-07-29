# 0025. Self-update: a separate updater, and a cutover that must earn the switch

## Status

Accepted. Implemented; automatic switching ships disabled (see below). Exercised end to end against
a real deployment, which changed the verification ladder — see
[the backlog](../BACKLOG.md#closed-what-a-live-self-update-test-found) for what it found and
[keeping a deployment up to date](../SELF-UPDATE.md) for how to run it.

## Context

Self-hosted software rots. It gets deployed, it works, and then it sits — unpatched, drifting away
from the internet around it — because updating is a chore nobody schedules. That failure mode is the
single most common way a homelab service becomes a liability, and "the operator will remember" has
never been true.

cutiemail is unusually well placed to fix this for itself. There is no build step (Node runs the
`.ts` directly), no dependency tree to resolve, no artefact to publish: a version *is* a commit. It
already ships the two things a careful update needs and most projects lack — `selftest`, which proves
the whole mail path end to end against a running daemon, and `backup`, which takes a consistent
snapshot with `VACUUM INTO`.

It is also unusually *dangerous* to get wrong. A mail server that fails to come back up does not
merely stop serving pages: inbound mail bounces or defers, submission fails silently in clients, and
the operator often finds out days later. An auto-updater that breaks the instance is worse than the
rot it prevents.

## Decision

### The updater is a separate program; the daemon can never write its own code

The mail daemon is the internet-facing, attack-surface-rich part. If it can rewrite its own source,
any remote code execution in it becomes *persistent* — the attacker writes the next version. The
systemd unit is deliberately sandboxed (`systemd-analyze security` ≈ 1.6, read-only filesystem bar
the data directory); a self-rewriting daemon throws that away.

So updating is a separate entry point (`node src/update/main.ts`), run from a systemd timer as its
own user, with write access to the version store and no ability to serve mail. The daemon keeps zero
write access to `/opt/mailserver`. `deploy/hetzner-up.sh`'s `chown -R mail:mail` is corrected as part
of this.

The updater necessarily uses `node:child_process` (to run a candidate and its tests) — the first use
anywhere in the tree. That is acceptable *because* it is not the mail server, and the zero-dependency
claim is about what answers port 25. Stated here so it is not later mistaken for erosion.

The same boundary runs the other way: **the updater ships code and never unit files.** Write access
to `/etc/systemd/system` would let it change `User=` and hand itself root, which would make every
other restriction here decorative — the polkit rule grants exactly one unit and three verbs for this
reason. The cost is that the unit is configuration no update can correct, and at least one of its
settings (`TimeoutStopSec`, which has to be at least the drain deadline or systemd kills first) is
load-bearing for the update mechanism itself. That is answered by *reporting* rather than by
widening the grant: `check`, `apply` and `status` each name a stop budget that is too short, the
setting that fixes it, and the value to use. Detection is compatible with containment; correction is
not.

### Git, spoken in Node, with no `git` binary

The updater implements git's smart HTTP protocol v2 directly over `fetch`, `node:zlib` and
`node:crypto`: `ls-refs` to learn where `main` points, `fetch` to pull a packfile, then packfile and
delta decoding, object verification, and a tree checkout. This is the same bet the rest of the
project makes about SMTP, IMAP, MIME and DKIM, and a packfile reader is simpler than the IMAP server.
It keeps "requires git" off the deployment page and keeps the update path testable with byte-exact
fixtures like everything else.

### Trust: TLS to GitHub, stated plainly

The trust root is TLS to `github.com` plus GitHub's access control on the repository. There is no
release signing. This is a deliberate choice, not an oversight: a signature only adds security if the
key lives somewhere GitHub does not, which means an offline signing ceremony performed reliably
forever. A key in CI would be theatre. What we buy instead is that everything *downstream* of "GitHub
told us the SHA" is verified by content addressing.

Object SHAs are checked (SHA-1, git's default; Node's `createHash` has no collision detection, so
this is integrity against corruption, not a security boundary — the security boundary is TLS).

What this does **not** protect against, recorded so nobody assumes otherwise: a compromise of GitHub
or of a maintainer account can ship code to every deployment.

### Provenance: descendant-only, and old enough

Two rules, both enforced locally:

- **The candidate must be a descendant of the commit we are running.** Verified by walking commit
  parents in the fetched objects. This makes rollback attacks impossible (nobody can move a
  deployment backwards), and makes a force-push that rewrites deployed history *refuse* rather than
  silently apply. Fix-forward becomes the only path that reaches deployments, which is the right
  discipline anyway.
- **The commit must be at least `bakeDays` old** (default 3), so a mistake merged to `main` has a
  window to be noticed and reverted before it reaches anyone.

A staleness alarm is the mirror image: the updater records every successful check, and *not having
been able to check* for longer than a threshold is surfaced as a problem. Otherwise anyone who can
simply block access to GitHub pins a deployment on an old version forever, and nothing notices —
the same rot, arriving through the mechanism meant to prevent it.

### The verification ladder

This is the heart of the decision. A candidate does not get switched to because it exists; it earns
the switch by climbing every rung, and any failure at any rung abandons the update and leaves the
running version untouched.

The design principle is that **each rung is stronger evidence than the last, and the expensive rungs
run against a copy of real data rather than a fixture.** Most auto-updaters stop at "the process
started". That is the rung that proves the least.

**1. Provenance** — descendant of current, at least `bakeDays` old.

**2. Integrity** — every object hashes to its SHA; every tree entry passes the checkout allow-list
(no `..`, no separators, no NUL, nothing matching `.git` case-insensitively, no symlink or gitlink
modes); packfile size, object count, inflated size and delta depth all bounded. A malformed pack is
"no update available", never a partial checkout.

**3. Shape** — the checkout contains what a cutiemail version must contain (`src/main.ts`,
`package.json` with a matching name, enough files and enough tests that a truncated tree cannot pass
by having nothing to run). Cheap, and catches a wrong-repo or truncated fetch before anything
expensive runs. It also checks `engines.node` against the runtime that would execute it: "the new
version needs a Node this host does not have" is a classic way for an auto-updater to brick a
deployment, and the failure arrives *after* the switch, as a syntax error from a feature the old
runtime cannot parse. A range we cannot evaluate is a refusal, not an assumption — a wrong guess
here is exactly the case that takes the service down.

A defect in the updater that blocks updates is **self-perpetuating**: the deployment cannot pull the
fix, because the broken check refuses every candidate. That is the argument for the staleness alarm
being load-bearing rather than decorative — "updates are configured but not arriving" is the only
signal that will ever reach an operator in that state — and for `check` mode existing at all, since
a deployment that reports without switching still surfaces the problem.

**4. It runs on this machine** — every module the candidate ships is imported, one at a time, in a
subprocess using the Node that is actually installed. The failing module is named.

This rung used to run the candidate's entire test suite, and that was wrong on the merits and fatal
in practice. On the merits: rungs 1 and 2 have already proved the checkout is byte-identical to a
commit CI tested, so re-running deterministic tests re-answers a settled question — a sequence-set
parser cannot behave differently on a Hetzner box than on a laptop. In practice: on the two shared
cores `deploy/hetzner-up.sh` provisions by default, the suite does not finish inside fifteen minutes,
so **every update was refused, with a message blaming the candidate.** Worse, the suite contains
wall-clock-sensitive cases that flake under contention, so the rung's most likely failure mode was
refusing a sound update — which teaches an operator that the safe setting is `off`.

What survives is the one thing that rung uniquely bought: whether this runtime can parse and
evaluate this code. `engines.node` in rung 3 checks a *declaration*, and a declaration is a claim
about a range, not evidence. A version adopting a language feature the installed Node predates
satisfies every declared constraint and then dies at the first import after the switch.

It is a regression gate and *not* a security boundary: a hostile version would ship a tree that
imports cleanly. Provenance is what stops a hostile version.

**5. Boot in isolation, and conformance measured as a regression** — the candidate starts with a
synthetic config on ephemeral loopback ports and a scratch database, and answers on all three. That
separates "the new version is broken" from "your data or configuration is the problem", which rung 6
cannot do on its own.

The SMTP conformance corpus then runs against that listener — and against the *currently running*
version, booted the same way, and the two are compared. **The gate is regression, not perfection.**
A conformance gap the running version already has is not a reason to refuse an update: refusing
would pin the deployment forever on the very version that has the gap, and the operator would never
receive the fix. A gap the candidate *introduces* is a different matter and fails the rung. Without a
baseline the corpus can only report, and says so rather than guessing.

A run in which every case came back inconclusive is treated as a failure. Readiness is measured by
whether the ports accept connections, and a listener that accepts and then says nothing is that
measurement's blind spot: it produces no findings, which the regression comparison would otherwise
read as "no new findings".

**6. Against a snapshot of *your* data — the rung that matters** — `VACUUM INTO` snapshots of
`control.db` and every `mail-<login>.db` are taken, and the candidate is started against **those
copies, with your real configuration**, on ephemeral loopback ports.

This happens in **two separate boots**, and the split is load-bearing. The first migrates and is
measured, and nothing else touches it, so the census taken afterwards can say *nothing changed* —
a claim impossible to make about a boot that was also asked to deliver mail, where a migration that
lost a message and a probe that added one are indistinguishable. The second boot does the work.

The first boot answers the questions that actually break deployments:

- does the candidate's schema migration succeed against your data, at your size?
- **how long does the migration take?** — measured here, because it is downtime later, and a
  ten-minute migration is something to know before taking the service down rather than after
- does your existing configuration still satisfy the new version, or has a new requirement appeared?
- do the accounts, aliases, mailboxes, message counts, UIDVALIDITY values and stored message bytes
  all survive unchanged?
- **does the stored authentication material survive byte for byte?** This is the quietest
  catastrophe available: nothing is deleted, no message moves, the server comes up reporting itself
  healthy, and every client is locked out permanently — and because SCRAM stores a salted, iterated
  verifier, the passwords cannot be recovered from what is left. Note the mail-path boot below does
  *not* cover it: that logs in with a credential the pre-flight minted moments earlier, which proves
  the auth algorithm works on a new verifier and says nothing about the ones your clients hold.

The measured migration time is also compared against the service unit's own `TimeoutStartSec`, read
from the unit rather than configured twice. A number on its own reads as reassurance; the judgement
that matters is whether the real cutover fits in the budget systemd will actually allow, because a
migration killed half-way through happens on the live databases rather than a copy.

Two corrections to that claim, both found by audit. It read the value with `Number()`, and systemd
renders every `*USec` property as a human timespan ("1min 30s") rather than an integer — so the parse
yielded `NaN`, `unitStartTimeoutMs` returned undefined on every real deployment, and the comparison
silently never ran. There is no machine-readable output mode for `systemctl show` to switch to, so
the timespan is now parsed. And the value read is `MAIL_UPDATE_UNIT`'s — the daemon's — which is
correct in intent but weaker than it sounds: `mailserver.service` is `Type=simple`, so systemd
considers it started at `fork()` and the start timeout does not actually bound the migration that
follows. The deadline that does bind is the cutover's own readiness timeout, after which it reverts.
The comparison is kept because a migration approaching either number is worth saying out loud, but it
is a warning about growth, not a guarantee about a kill.

The second boot proves the mail path end to end against real data: authenticated submission, local
delivery and IMAP read-back, driven by `selftest` against a real account's real mailbox. Accounts
store SCRAM material, so no existing password can be recovered — which is the right property, and
means the updater mints an **app password inside the snapshot** to log in with. That is safe there
and only there: it is a copy, destroyed minutes later, and the live registry is untouched.

**Outbound signing is checked separately, because local delivery never reaches the signer.** A
submitted message is signed only on the copy bound for a remote domain; the local copy is stamped
with a `Received` trace and stored unsigned. So the `selftest` probe above — which delivers to the
account itself — cannot see the signer at all, and a candidate that stopped signing outright passed
every rung, cut over, and sent unsigned mail. Nothing downstream catches that: the probe passes, the
watch window passes, the daemon is entirely healthy, and the operator finds out from DMARC aggregate
reports days after the version was confirmed. The rung therefore submits a second message to a
reserved remote domain and inspects the **queued** copy for a `DKIM-Signature` carrying the expected
domain and selector. Nothing is sent — `MAIL_OUTBOUND=hold` is forced for every candidate boot.

That check needs a key, and the updater cannot read yours by design (see the containment argument
above; it is a different user precisely so a compromise of it is not a compromise of the mail). The
answer is a **stand-in**, not a skip. Unreadable key material used to delete the variable, which
moved the candidate onto a different branch — the bundled dev certificate rather than a file read,
and no signer at all rather than a signer — so the production path went untested in exactly the two
places most likely to break mail. A written-out certificate and a generated DKIM key exercise the
same code with material of the same shape. The reduction in fidelity that remains is real, narrow,
and reported: whether the operator's own key files parse, which an update does not affect.

**Readiness is the ports accepting, in the cutover as well as the pre-flight.** `systemctl start`
returns when systemd considers a `Type=simple` unit started — the moment its process is forked, not
the moment it serves. On a real box the gap is around 460 ms for an idle deployment, and it is
exactly the work rung 6a measures: opening the databases, applying any migration, binding three
ports. A probe issued inside that window reports "could not connect to the submission port" about a
daemon that is running perfectly well, and the cutover reverts a good update. The probe therefore
waits for the ports, generously, because the migration it is waiting through is the one that scales
with your mailbox — a bound that is merely usually-enough turns a slow migration into a spurious
revert, and spurious reverts are what teach an operator to switch updates off. Not-listening is
reported as its own outcome, because "the process is up and has not begun serving" and "the mail
path is broken" call for opposite responses.

**Only one run at a time.** Every run begins by recovering an interrupted cutover, and no process
can tell another's legitimate in-progress switch from a crashed one — so a second run reverts the
first. systemd already prevents two instances of the update unit; the store's own lock covers
everything else (a hand-run command during a timer tick, a stray second timer). `status` is exempt:
it is read-only, and an operator diagnosing a stuck run is exactly who needs it.

**What access the updater needs, and why it is not more than it looks.** The updater runs as its own
user precisely so that a compromise of the internet-facing daemon cannot rewrite the code that runs
next. That separation is one-directional: the updater still needs the *data*. It reads every
database to snapshot them, and it **writes** the control database, because the cutover probe mints
an app password immediately before the check and revokes it immediately after — the update is
confirmed by a real message through authenticated submission, not by the process being up. On a
deployment where the daemon creates its files 0600, group membership alone does not deliver that;
a POSIX ACL with a default entry does, and survives the daemon's umask without widening it. Getting
this wrong does not fail loudly at install time — it fails at the probe, months later, and reverts.

**6c. Can we get back?** — the version that is *currently running* is booted against the snapshot the
candidate has just migrated. If it cannot open it, the update is one-way and is refused, unless
`MAIL_UPDATE_ALLOW_IRREVERSIBLE=yes` says otherwise.

This is the rung the ladder was missing, and everything else leans on it. The pre-flight cannot test
the systemd sandbox: it spawns the candidate itself, so `ProtectSystem`, `SystemCallFilter`, the
capability bounding set and `ReadWritePaths` are all absent. The **cutover** can and does — it
restarts the real unit and then pushes a real message through the real ports — and its answer to a
failure is to rename the symlink back. So the sandbox, and every environmental difference nobody has
thought of, is covered by revert working. That makes revert the load-bearing guarantee of the whole
design, and it is what makes dropping the test suite in rung 4 a sound trade rather than a
concession: correctness-confidence and recoverability are substitutes, and this buys the cheaper one.

And revert only restores the *code*. If the migration has moved the data to a schema the running
version cannot read, renaming the symlink back produces a dead server, and the only way home is
restoring the pre-cutover snapshot by hand, during whatever incident prompted the revert. Inferring
this from a schema version number is not enough — a number going up says nothing about whether the
old code can still read what is there. The old binary either opens it or it does not.

Three safety rules are absolute here, because this rung runs a downloaded program with production
configuration:

- **Every account's mail-database path in the snapshot is rewritten to point inside it.** The
  control database stores an absolute path per account, so a verbatim copy still names the *live*
  mailbox files — and a candidate booted against it would open, migrate and write real mail while
  believing it was running against a copy. The rewrite is what makes a copy a copy, and the snapshot
  is refused outright if any account still points outside it afterwards.
- **`MAIL_OUTBOUND=hold` is forced.** The snapshot contains the outbound queue. A candidate booted
  against it in `deliver` mode would relay every queued message a second time. This is the single
  most dangerous thing about testing with real data, and it is why hold mode is a hard override
  rather than a default. The census is what turns that from an assertion into evidence: it digests
  each queued message's remaining recipients, attempt count and next-attempt time, so a relay tick
  that ran and *failed* — leaving the row in place, merely rescheduled — is caught just as surely as
  one that succeeded. A depth comparison alone would miss it entirely.
- **Loopback-only, ephemeral ports.** The candidate never binds 25, 587 or 993, and is never
  reachable from off the machine. The bind address is overridden rather than inherited, because a
  real deployment's is public.

`MAIL_UPDATE_*` is stripped from the candidate's environment: a program still being judged has no
business reaching out to the network and rewriting the version store that is deciding its fate.

Stored message bytes are hashed in full below half a gigabyte and fingerprinted by length plus their
first and last 8 KiB above it, and the report says which. A pre-flight that takes twenty minutes gets
killed by a service timeout, and an update that never completes is the rot this exists to prevent.

One honest limitation: in a correct deployment the updater is a different user from the daemon and
the TLS key is `0600`, so the check usually cannot read the real certificate and falls back to the
bundled loopback-only development one. That is a real reduction in fidelity and is reported as such
rather than glossed over.

The snapshots are destroyed afterwards whatever the outcome.

**7. Cutover preconditions** — a fresh snapshot exists and passes `verify`; there is disk space to
roll back; the drain (below) completed within its deadline.

**8. Post-cutover probe** — after the switch, the new instance must prove itself *live*: a real
message through authenticated submission on the real port, delivered, read back over IMAP, and
deleted. Anything short of that would miss a version that binds its ports and then fails on every
message. The probe credential is an app password minted immediately before and revoked immediately
after, so there is no standing password anywhere — not a new privilege for the updater, which
already holds database access in order to take snapshots at all, but a credential that exists for
ninety seconds is a smaller thing to lose than one that exists forever.

**9. Confirmation** — only after the probe window passes without incident is the new version marked
good and older versions become eligible for pruning. "It started" is not confirmation.

### The cutover: drained, reversible, and crash-safe

**Drain before switch.** The updater asks the running daemon to stop accepting work and finish what
it has: `SmtpReceiver.close()` already awaits in-flight handlers and `relayLoop.stop()` already awaits
the current tick, so "not busy" has a real definition rather than a guess — no message part-way
through DATA, no relay tick mid-delivery. IMAP sessions get `* BYE` so clients reconnect cleanly
rather than seeing a dropped socket. If the drain does not complete within its deadline, the cutover
is **abandoned**, not forced: the update can wait, an interrupted delivery cannot be undone.

**An explicit state machine, written to disk atomically.** `IDLE → FETCHED → VERIFIED → SNAPSHOTTED →
DRAINING → SWITCHING → PROBING → CONFIRMED`, with `REVERTING` reachable from the last three. Each
transition is a write-temp-and-rename, so a power cut mid-cutover leaves a state the next run can
recover from deterministically rather than an ambiguous half-switched tree.

**Automatic revert.** If the probe fails, or the new version stops running inside the watchdog
window, the updater flips the symlink back and restarts. If the candidate's migration moved the
schema forward, the pre-cutover snapshot is restored, because an older binary cannot safely read a
newer database — flipping the symlink alone would leave a version that cannot start at all.

**A revert never deletes.** Restoring costs whatever arrived between the snapshot and the failure —
usually nothing, because the service is down for most of that window — but it is a real cost, so the
failed version's databases are MOVED ASIDE rather than removed and the operator is told where.

The write-ahead log is the trap, and it cuts both ways. Copying a snapshot over a live database
while a `-wal` sidecar remains makes SQLite replay those frames on the next open, resurrecting state
the snapshot never held — so the sidecars of the file being *replaced* must go. But a WAL database is
three files, and for a while only the main one was moved aside while the sidecars kept their original
name and were then unlinked with everything else. The preserved copy was therefore silently rolled
back to its last checkpoint, and what it lost was mail the server had already answered `250` for. The
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
but never switches. `apply` is available by hand from the first day, and setting the mode to `apply`
hands the timer the keys. `off` pins a deployment entirely, including a hand-run `apply`.

The default is `check` rather than `off` because the *reporting* is worth having immediately and
carries no risk: it is what makes the staleness alarm meaningful, and a deployment that is silently
not checking is the failure this whole mechanism exists to prevent. What waits for trust is the
switching, and the intent is to default that on once it has earned it — that flip is its own
decision, not this one.

## Consequences

- A deployment left alone stays current, which is the whole point.
- The strongest gate is rung 6, and it is only possible because `backup`, `selftest` and the
  conformance suite already exist. Their value was never only the thing they were built for.
- An update can be *refused* for reasons that look like inconvenience — the drain did not finish, the
  commit is too fresh, the migration takes too long, disk is short. Refusing is always correct: the
  running version already works.
- The updater becomes the project's most security-critical component, and the first that parses
  attacker-influenceable binary data and then writes files from it. It is treated like every other
  parser here: bounded, fuzzed, and mutation-tested, with negative controls for each refusal —
  a `..` in a tree entry, a symlink escape, a `.git` path, a bad object SHA, a non-terminating delta
  chain, a decompression bomb. **A gate never shown to fail does not count as a gate**, and that
  applies with more force here than anywhere: a pre-flight that silently always passes converts
  "it updates itself" from a safeguard into a false assurance.
- Updating is not the same as staying healthy. Node going EOL, OS packages, certificate renewal and
  provider policy changes are outside what this can fix; `doctor` remains the answer there. The
  documentation must not imply otherwise.
