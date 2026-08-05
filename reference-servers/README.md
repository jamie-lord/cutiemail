# Reference servers and calibration

These servers are the suite's **ground truth**. They are not servers under test. The calibration
run tests THE SUITE, not the servers. If the suite reports a violation against a spec-scrutinised
MTA, the overwhelming prior is that the suite is wrong.

## Why calibration is not optional

The suite's runner is our own code. Without calibration, we could confidently report our own
defects as other people's non-conformance. A conformance suite that has never run against a
known-good server is an untested instrument.

## Status: DONE against four independent MTAs, zero false positives

The suite is calibrated. It ran against four SMTP implementations, each written independently.
This list gives them in order of real-world prominence. Postfix ran through the pinned
`docker-compose.yml`, in **two configs** (a vulnerable config and a hardened config, see below).
Exim, mox, and aiosmtpd used **native** installations (no Docker). Each ran as an isolated,
unprivileged test daemon with its own config, its own spool, a high port, and no root. The host's
system mail stayed untouched:

| MTA | Version | Result (conformant / non-conf / latitude / inconclusive) | False positives |
|---|---|---|---|
| Postfix (vulnerable) | 3.7.11 (`boky/postfix:v4.3.0`) | 57 / 5 / 1 / 8 | **0** |
| Postfix (hardened) | 3.7.11, `smtpd_forbid_bare_newline=yes` | 59 / 3 / 1 / 8 | **0** |
| Exim | 4.99.4 (`brew install exim`) | 59 / 2 / 0 / 7 | **0** |
| mox | 0.0.15 (`brew install mox`) | 37 / 2 / 1 / 28 | **0** |
| aiosmtpd | 1.4.6 (pip, venv) | 59 / 4 / 0 / 6 | **0** |

The Postfix pair is the strongest single result. It uses the **same binary**, first vulnerable to
SMTP smuggling, then hardened. The suite flags the two end-of-data smuggling vectors on the
vulnerable config. It **positively blesses** them on the hardened config, with no collateral
movement. The false-positive discipline was built on one promise: "never convict a hardened
Postfix". This result now demonstrates that promise both ways. See the full triage in
[CALIBRATION-postfix.md](CALIBRATION-postfix.md).

(The row totals differ because the corpus grew over time. Each row is stamped with the corpus it
ran against. Exim and mox use the 68-case corpus. aiosmtpd uses the 69-case corpus (it added
`mail`-resets-recipient-state, `R-5321-3.3-b`). Postfix uses the current 71-case corpus. If you
re-run the earlier three on the current corpus, the totals align. See
`CALIBRATION-differential.md`.)

Every finding traces to a real cause: either a genuine byte-verified divergence or our own minimal
test config. For the divergences, all four servers honour bare-LF command terminators
(`R-5321-2.3.8-a`/`R-5321-4.1.1.4-i`). On control octets the four servers split 2-2: aiosmtpd and
Postfix accept a NUL/BEL, and Exim and mox reject it. No finding was a suite bug or an RFC
misreading. See `CALIBRATION-exim.md`, `CALIBRATION-aiosmtpd.md`, `CALIBRATION-postfix.md`, and
`CALIBRATION-differential.md` (the Exim×mox agreement matrix). **The instrument is validated. It
makes no false accusation across the conformant behaviours of four independent codebases. One
codebase was tested in two security postures.**

## OpenSMTPD: not yet calibrated

Postfix is now calibrated (through Docker, see the status table and `CALIBRATION-postfix.md`).
OpenSMTPD is the one remaining canonical receiver that has not run. It would add corroborating
weight. But the calibration *goal* is already met four times over: validate the suite against real
independent MTAs with zero false positives. OpenSMTPD needs a host that can run it as an isolated,
unprivileged test daemon, or it needs a container image. On any host where Docker runs, a target
config in the shape of `postfix.json` runs unchanged and adds the data point.

### Historical note: the macOS-native Postfix dead-end

Before Docker was available here, a rootless native Postfix instance on macOS could not run. For
that reason, the three earlier calibrations used native Exim, mox, and aiosmtpd instead. This note
records the finding so it is reproducible, not merely asserted. OpenSMTPD would meet the same
barrier natively on macOS. There is no Homebrew formula, and Apple's SIP-hardened system daemons
will not run outside their system context:

- **No Homebrew formula** exists for either `postfix` or `opensmtpd`. Exim and mox calibrated
  cleanly precisely because they *are* Homebrew binaries pinned to a package version.
- **macOS's system Postfix cannot substitute.** It ships `/usr/sbin/postfix`. An isolated
  unprivileged instance uses the exact pattern that worked for Exim: its own config dir, its own
  queue tree, and a high port. This instance reaches a clean `postfix check`. But the Apple-signed
  `master` daemon then exits immediately with **no diagnostic**. There is nothing on stdout or
  stderr and nothing in the unified log, even in foreground debug mode (`master -c DIR -d -v`). It
  will not run outside its SIP-protected system context. Docker avoids this problem completely.

### Reproducing the (macOS-blocked) system-Postfix attempt

```sh
BASE=$(mktemp -d)/pf; mkdir -p "$BASE"/{etc,spool,data}
# main.cf: isolated queue/data dirs, mail_owner=$(id -un), loopback smtpd on 2526,
#   mydestination=example.com, reject_unauth_destination (matches postfix.json fixture)
# master.cf: a single "2526 inet n - n - - smtpd" service
/usr/sbin/postfix -c "$BASE/etc" check          # passes
mkdir -p "$BASE"/spool/{pid,private,public,active,incoming,deferred,defer,bounce,corrupt,flush,hold,maildrop,saved,trace}
/usr/libexec/postfix/master -c "$BASE/etc" -d -v # exits instantly, silent, SIP-hardened
```

## Running a containerised calibration (Linux / any Docker host)

These steps calibrated Postfix (2026-07-22):

```sh
cd reference-servers
docker compose up -d
# give the servers a few seconds to accept connections
node ../src/cli.ts run --config postfix.json          --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config postfix-hardened.json --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config exim.json              --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose down
```

The native-install recipes for Exim, mox, and aiosmtpd are in each `CALIBRATION-*.md` and in
`exim-test.conf.example`. They need no Docker.

## The triage discipline

You MUST triage every reported finding against a reference server to exactly one of these causes:

1. **Our bug**: the test, the reply reader, or the runner is wrong. Fix the suite. This is
   the expected outcome for most early findings.
2. **Our misreading of the RFC**: the test asserts something RFC 5321 does not require
   (a false positive: asserting an exact code where the spec permits a class, assuming an
   optional behaviour). Fix the test AND the register note that misled it.
3. **A genuine divergence**: the reference MTA really does deviate here. This is rare, and
   extraordinary claims need the transcript as evidence. Record it as a register `bisNote`
   or a divergence note. Do NOT quietly keep a test that fails a reference server without
   this justification.

A finding with no completed triage is a blocker. The suite is not trustworthy while one exists.
(All findings in the completed runs are triaged. See the calibration write-ups.)

## What a healthy calibration looks like

- Zero `non-conformant` findings that survive triage as our bug or misreading. That is, every red
  is either fixed or documented as a real divergence. **Achieved on all runs.**
- A meaningful number of `inconclusive` results is EXPECTED and acceptable. They mark requirements
  that depend on fixtures these minimal reference configs do not provide (a rejected recipient, a
  quota, a relay domain). The coverage report shows which requirements.
- The `permitted-latitude` count reflects SHOULDs these servers decline. This is acceptable, and
  it is itself useful data for the matrix.

## Version pinning

Every result is stamped with the server version, so a run's provenance is unambiguous. This avoids
the flaw that let Dovecot's published imaptest table rot for 14 years while it looked current.
Change versions deliberately and re-triage. A new MTA version can change conformant behaviour. The
containerised Postfix pins to an image tag (`boky/postfix:v4.3.0`, Postfix 3.7.11). Each JSON's
`version` label matches `postconf mail_version` on the running container. If you need
byte-identical provenance across hosts, pin to a digest (`image: boky/postfix@sha256:...`).

Note that the image tag and the Postfix version differ. `boky/postfix:v4.3.0` ships Postfix
**3.7.11**, whose `smtpd_forbid_bare_newline` default is `no`. This is deliberate. It lets
`postfix.json` exercise the unmitigated smuggling path, while `postfix-hardened.json` (the same
image with `smtpd_forbid_bare_newline=yes`) exercises the fix.

(Exim, mox, and aiosmtpd used native installs rather than containers: no Docker dependency, and
each pinned to a real package version. Postfix used the container because a rootless native Postfix
will not run on macOS. See the historical note above.)
