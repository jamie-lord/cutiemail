# Reference servers and calibration

These are the suite's **ground truth**, not servers under test. The calibration run exists to
test THE SUITE, not them: when the suite reports a violation against a spec-scrutinised MTA,
the overwhelming prior is that the suite is wrong.

## Why calibration is not optional

The suite's runner is our own code. Calibration is the only thing standing between us and
confidently reporting our own defects as other people's non-conformance. A conformance suite
that has never been pointed at a known-good server is an untested instrument.

## Status: DONE against four independent MTAs, zero false positives

The suite is calibrated. It has been run against four independently-written SMTP
implementations, listed here by real-world prominence. Postfix was run via the pinned
`docker-compose.yml`, in **two configs** (a vulnerable and a hardened one, see below); Exim, mox,
and aiosmtpd were installed **natively** (no Docker) as isolated, unprivileged test daemons with
their own config, own spool, a high port, no root, and the host's system mail untouched:

| MTA | Version | Result (conformant / non-conf / latitude / inconclusive) | False positives |
|---|---|---|---|
| Postfix (vulnerable) | 3.7.11 (`boky/postfix:v4.3.0`) | 57 / 5 / 1 / 8 | **0** |
| Postfix (hardened) | 3.7.11, `smtpd_forbid_bare_newline=yes` | 59 / 3 / 1 / 8 | **0** |
| Exim | 4.99.4 (`brew install exim`) | 59 / 2 / 0 / 7 | **0** |
| mox | 0.0.15 (`brew install mox`) | 37 / 2 / 1 / 28 | **0** |
| aiosmtpd | 1.4.6 (pip, venv) | 59 / 4 / 0 / 6 | **0** |

The Postfix pair is the strongest single result: the **same binary**, vulnerable to SMTP smuggling
then hardened, and the suite flags the two end-of-data smuggling vectors on the first and
**positively blesses** them on the second, with no collateral movement. That is the promise the
false-positive discipline was built on ("never convict a hardened Postfix"), now demonstrated both
ways. Full triage in [CALIBRATION-postfix.md](CALIBRATION-postfix.md).

(The row totals differ because the corpus grew over time and each row is stamped with the suite it
ran against: Exim and mox are the 68-case corpus, aiosmtpd the 69-case (it added
`mail`-resets-recipient-state, `R-5321-3.3-b`), and Postfix the current 71-case. Re-running the
earlier three on the current corpus would align the totals; see `CALIBRATION-differential.md`.)

Every finding was triaged to a real cause: a genuine byte-verified divergence (all four
honour bare-LF command terminators, `R-5321-2.3.8-a`/`R-5321-4.1.1.4-i`; on control octets the
four split 2-2, with aiosmtpd and Postfix accepting a NUL/BEL and Exim and mox rejecting it) or
our own minimal test config. None was a suite bug or an RFC misreading. See `CALIBRATION-exim.md`, `CALIBRATION-aiosmtpd.md`, `CALIBRATION-postfix.md`, and
`CALIBRATION-differential.md` (the Exim×mox agreement matrix). **The instrument is validated: it
makes no false accusation across the conformant behaviours of four independent codebases, one of
them tested in two security postures.**

## OpenSMTPD: not yet calibrated

Postfix is now calibrated (via Docker, see the status table and `CALIBRATION-postfix.md`).
OpenSMTPD is the one remaining canonical receiver not yet run. It would add corroborating weight,
but the calibration *goal* (validate the suite against real independent MTAs with zero false
positives) is already met four times over. It needs a host that can run it as an isolated,
unprivileged test daemon, or a container image; on anywhere Docker runs, a target config in the
shape of `postfix.json` runs unchanged and adds the data point.

### Historical note: the macOS-native Postfix dead-end

Before Docker was available here, Postfix was attempted as a rootless native instance on macOS
and could not run, which is why the three earlier calibrations used native Exim/mox/aiosmtpd
instead. It is recorded so the finding is reproducible, not asserted, and because OpenSMTPD would
hit the same wall natively on macOS (no Homebrew formula; Apple's SIP-hardened system daemons will
not run outside their system context):

- **No Homebrew formula** exists for either `postfix` or `opensmtpd`. Exim and mox calibrated
  cleanly precisely because they *are* Homebrew binaries pinned to a package version.
- **macOS's system Postfix cannot stand in.** It ships `/usr/sbin/postfix`, and an isolated
  unprivileged instance, the exact pattern that worked for Exim (own config dir, own queue
  tree, a high port), gets as far as a clean `postfix check`, but the Apple-signed `master`
  daemon then exits immediately with **no diagnostic**: nothing on stdout/stderr, nothing in
  the unified log, even in foreground debug mode (`master -c DIR -d -v`). It will not run
  outside its SIP-protected system context. Docker sidesteps this entirely.

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

This is how Postfix was calibrated (2026-07-22):

```sh
cd reference-servers
docker compose up -d
# give the servers a few seconds to accept connections
node ../src/cli.ts run --config postfix.json          --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config postfix-hardened.json --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config exim.json              --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose down
```

The Exim/mox/aiosmtpd native-install recipes are in each `CALIBRATION-*.md` and in
`exim-test.conf.example`; they need no Docker.

## The triage discipline

Every reported finding against a reference server MUST be triaged to exactly one of:

1. **Our bug**: the test, the reply reader, or the runner is wrong. Fix the suite. This is
   the expected outcome for most early findings.
2. **Our misreading of the RFC**: the test asserts something RFC 5321 does not require
   (a false positive: asserting an exact code where the spec permits a class, assuming an
   optional behaviour). Fix the test AND the register note that misled it.
3. **A genuine divergence**: the reference MTA really does deviate here. Rare, and
   extraordinary claims need the transcript as evidence. Record it as a register `bisNote`
   or a divergence note; do NOT quietly keep a test that fails a reference server without
   this justification.

A finding with no completed triage is a blocker. The suite is not trustworthy while one exists.
(All findings in the completed runs are triaged; see the calibration write-ups.)

## What a healthy calibration looks like

- Zero `non-conformant` findings that survive triage as our bug or misreading. That is, every red
  is either fixed or documented as a real divergence. **Achieved on all runs.**
- A meaningful number of `inconclusive` results is EXPECTED and fine: they mark requirements
  gated on fixtures these minimal reference configs don't provide (a rejected recipient, a
  quota, a relay domain). The coverage report shows which.
- The `permitted-latitude` count reflects SHOULDs these servers decline, which is fine and
  itself interesting data for the matrix.

## Version pinning

Every result is stamped with the server version, so a run's provenance is unambiguous, avoiding
the flaw that let Dovecot's published imaptest table rot 14 years while looking current. Bump
versions deliberately and re-triage; a new MTA version can change conformant behaviour. The
containerised Postfix pins to an image tag (`boky/postfix:v4.3.0`, Postfix 3.7.11); the `version`
label in each JSON was reconciled against `postconf mail_version` on the running container. Pin to
a digest (`image: boky/postfix@sha256:...`) if you need byte-identical provenance across hosts.

Note the image tag and the Postfix version differ: `boky/postfix:v4.3.0` ships Postfix **3.7.11**,
whose `smtpd_forbid_bare_newline` default is `no`. That is deliberate here: it lets `postfix.json`
exercise the unmitigated smuggling path while `postfix-hardened.json` (the same image with
`smtpd_forbid_bare_newline=yes`) exercises the fix.

(Exim/mox/aiosmtpd used native installs rather than containers: no Docker dependency, each pinned
to a real package version. Postfix used the container because a rootless native Postfix will not
run on macOS; see the historical note above.)
