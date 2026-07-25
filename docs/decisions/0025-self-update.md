# 0025. Self-update: a separate updater, and a cutover that must earn the switch

## Status

Proposed.

## Context

Self-hosted software rots. It gets deployed, it works, and then it sits — unpatched, drifting away
from the internet around it — because updating is a chore nobody schedules. That failure mode is the
single most common way a homelab service becomes a liability, and "the operator will remember" has
never been true.

cutiemail is unusually well placed to fix this for itself. There is no build step (Node runs the
`.ts` directly), no dependency tree to resolve, no artefact to publish: a version *is* a commit. It
already ships the two things a careful update needs and most projects lack — `selftest`, which proves
the whole mail path end to end against a running daemon, and `backup`, which takes a consistent
snapshot with `VACUUM INTO`. And its own test suite is large and fast enough to run as a gate.

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
`package.json` with a matching name, the test tree). Cheap, and catches a wrong-repo or truncated
fetch before anything expensive runs.

**4. The candidate's own test suite** — run in the candidate tree, in a subprocess, with a timeout.
This is the regression gate the project already maintains, and it costs about two minutes.

**5. Boot in isolation** — the candidate starts with a synthetic config on ephemeral loopback ports
and a scratch database, and answers on all three. Proves the entry point works before we let it near
anything real.

**6. Against a snapshot of *your* data — the rung that matters** — `VACUUM INTO` snapshots of
`control.db` and every `mail-<login>.db` are taken, and the candidate is started against **those
copies, with your real configuration**, on ephemeral loopback ports. This is the only rung that can
answer the questions that actually break deployments:

- does the candidate's schema migration succeed against your data, at your size?
- **how long does the migration take?** — measured here, because it is downtime later, and a
  ten-minute migration is something to know before taking the service down rather than after
- does your existing configuration still satisfy the new version, or has a new requirement appeared?
- do the accounts, mailboxes and message counts survive the migration unchanged?
- can a sample of real messages be read back over IMAP byte-identically?
- does `selftest` — authenticated submission, local delivery, IMAP read-back — pass against the
  candidate?
- does the SMTP conformance suite still pass against the candidate's own listener?

Two safety rules are absolute here, because this rung runs the candidate with production
configuration:

- **`MAIL_OUTBOUND=hold` is forced.** The snapshot contains the outbound queue. A candidate booted
  against it in `deliver` mode would relay every queued message a second time. This is the single
  most dangerous thing about testing with real data, and it is why hold mode is a hard override
  rather than a default.
- **Loopback-only, ephemeral ports.** The candidate never binds 25, 587 or 993, and is never
  reachable from off the machine.

The snapshots are destroyed afterwards whatever the outcome.

**7. Cutover preconditions** — a fresh snapshot exists and passes `verify`; there is disk space to
roll back; the drain (below) completed within its deadline.

**8. Post-cutover probe** — after the switch, the new instance must prove itself *live*: answer on
all three ports, and pass a full mail-path probe (submission → delivery → IMAP read-back) using a
dedicated app password held by the updater. Message counts are compared against the pre-cutover
census. Anything failing inside the probe window triggers an automatic revert.

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

**Automatic revert.** If the probe fails, or the new version exits twice inside the watchdog window,
the updater flips the symlink back and restarts. If the candidate's migration moved the schema
forward, the pre-cutover snapshot is restored, because an older binary cannot safely read a
newer database.

**Schema versions make that decidable.** Both database kinds carry `PRAGMA user_version`. Every build
declares the version it writes and the minimum it can read, and refuses to open a database from the
future rather than misbehaving against it. Without this, rollback is a guess.

### Off by default at first, then on

Automatic switching ships **disabled**, with `check` and `apply` available by hand, so the mechanism
earns trust on real deployments before it is given the keys. The intent is to default it on once it
has; that flip is its own decision, not this one.

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
