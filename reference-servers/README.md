# Reference servers and calibration

These are the suite's **ground truth**, not servers under test. The calibration run exists to
test THE SUITE, not them: when the suite reports a violation against a spec-scrutinised MTA,
the overwhelming prior is that the suite is wrong.

## Why calibration is not optional

The suite's runner is our own code. Calibration is the only thing standing between us and
confidently reporting our own defects as other people's non-conformance. A conformance suite
that has never been pointed at a known-good server is an untested instrument.

## Status: DONE against three independent MTAs — zero false positives

The suite is calibrated. It has been run against three independently-written SMTP
implementations, each installed **natively** (no Docker) as an isolated, unprivileged test
daemon — own config, own spool, a high port, no root, the host's system mail untouched:

| MTA | Version | Result (conformant / non-conf / inconclusive) | False positives |
|---|---|---|---|
| Exim | 4.99.4 (`brew install exim`) | 59 / 2 / 7 | **0** |
| mox | 0.0.15 (`brew install mox`) | 37 / 2 / 28 | **0** |
| aiosmtpd | 1.4.6 (pip, venv) | 59 / 4 / 6 | **0** |

Every finding was triaged to a real cause — a genuine byte-verified divergence (all three
honour bare-LF command terminators, `R-5321-2.3.8-a`/`R-5321-4.1.1.4-i`; aiosmtpd additionally
accepts NUL/BEL control octets) or our own minimal test config — never a suite bug or an RFC
misreading. See `CALIBRATION-exim.md`, `CALIBRATION-aiosmtpd.md`, and `CALIBRATION-differential.md`
(the Exim×mox agreement matrix). **The instrument is validated: it makes no false accusation
across 155 conformant behaviours spanning three independent codebases.**

## Postfix and OpenSMTPD: unavailable in this environment (investigated 2026-07-17)

The two canonical spec-strict receivers would add corroborating weight — Postfix especially,
since the suite's whole false-positive discipline was designed around not convicting a hardened
Postfix. Neither can run here, for concrete, verified reasons:

- **No Homebrew formula** for either `postfix` or `opensmtpd` (both checked). Exim and mox
  calibrated cleanly precisely because they *are* Homebrew binaries under our control.
- **The system Postfix is SIP-hardened against a rootless instance.** macOS ships
  `/usr/sbin/postfix`, and an isolated unprivileged daemon — the exact pattern that worked for
  Exim (own config dir, own queue tree, port 2526) — gets as far as a clean `postfix check`,
  but the master daemon then exits immediately with **no diagnostic**: nothing on stdout/stderr,
  nothing in the unified log, even run in foreground debug mode (`master -c DIR -d -v`). The
  Apple-signed daemons will not run outside their system context. Steps are below so the finding
  is reproducible, not asserted.
- **Docker is non-functional here** (the VM's registry egress is broken — archived diagnosis at
  the foot of this file), so the containerised `boky/postfix` path can't run either.

This is a recorded environment limitation, **not missing work**. The calibration *goal* —
validate the suite against real independent MTAs with zero false positives — is met by the three
above. A fourth (Postfix) would corroborate, not unblock. On a host with a package-manager
Postfix or working Docker egress, the config and JSON here run unchanged and add the data point.

### Reproducing the (blocked) system-Postfix attempt

```sh
BASE=$(mktemp -d)/pf; mkdir -p "$BASE"/{etc,spool,data}
# main.cf: isolated queue/data dirs, mail_owner=$(id -un), loopback smtpd on 2526,
#   mydestination=example.com, reject_unauth_destination (matches postfix.json fixture)
# master.cf: a single "2526 inet n - n - - smtpd" service
/usr/sbin/postfix -c "$BASE/etc" check          # passes
mkdir -p "$BASE"/spool/{pid,private,public,active,incoming,deferred,defer,bounce,corrupt,flush,hold,maildrop,saved,trace}
/usr/libexec/postfix/master -c "$BASE/etc" -d -v # exits instantly, silent — SIP-hardened
```

## Running a containerised calibration (only if Docker egress works here)

```sh
cd reference-servers
docker compose up -d
# give the servers a few seconds to accept connections
node ../src/cli.ts run --config postfix.json --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config exim.json    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose down
```

The native-install recipe used for the three completed runs is in each `CALIBRATION-*.md` and
in `exim-test.conf.example`; prefer it — it needs no Docker.

## The triage discipline

Every reported finding against a reference server MUST be triaged to exactly one of:

1. **Our bug** — the test, the reply reader, or the runner is wrong. Fix the suite. This is
   the expected outcome for most early findings.
2. **Our misreading of the RFC** — the test asserts something RFC 5321 does not require
   (a false positive: asserting an exact code where the spec permits a class, assuming an
   optional behaviour). Fix the test AND the register note that misled it.
3. **A genuine divergence** — the reference MTA really does deviate here. Rare, and
   extraordinary claims need the transcript as evidence. Record it as a register `bisNote`
   or a divergence note; do NOT quietly keep a test that fails a reference server without
   this justification.

A finding with no completed triage is a blocker. The suite is not trustworthy while one exists.
(All findings in the three completed runs are triaged — see the calibration write-ups.)

## What a healthy calibration looks like

- Zero `non-conformant` findings that survive triage as our bug or misreading — i.e. every red
  is either fixed or documented as a real divergence. **Achieved on all three runs.**
- A meaningful number of `inconclusive` results is EXPECTED and fine: they mark requirements
  gated on fixtures these minimal reference configs don't provide (a rejected recipient, a
  quota, a relay domain). The coverage report shows which.
- The `permitted-latitude` count reflects SHOULDs these servers decline — also fine, and
  itself interesting data for the matrix.

## Version pinning

Every result is stamped with the server version, so a run's provenance is unambiguous — the
flaw that let Dovecot's published imaptest table rot 14 years while looking current. Bump
versions deliberately and re-triage; a new MTA version can change conformant behaviour. For a
containerised run, pin the image to a digest (`image: boky/postfix@sha256:...`) and reconcile
the `version` label against `postconf mail_version` / `exim -bV` on first run.

---

## Archived: the Docker blocker (2026-07-16)

The original plan was a containerised Postfix/Exim via `docker compose`. It could not run here,
and the native installs above superseded it. Kept for the record:

- The Docker daemon started, but pulls hung indefinitely. `docker pull hello-world` (a ~13 KB
  image) never completed; no image layer was ever committed.
- The break was inside Docker Desktop's Linux VM, not the host network. From the host,
  `curl https://registry-1.docker.io/v2/` returned 401 (the correct "authenticate" response)
  and `auth.docker.io/token` returned 200 in <300 ms — the registry was reachable; the VM's
  egress to it was not. A full Docker restart did not recover it.

This is why the calibration was completed against natively-installed MTAs instead — which is a
better recipe anyway (no Docker dependency, pinned to a real package version).
