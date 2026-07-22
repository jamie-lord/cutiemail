# Calibration against Exim 4.99.4

One of the two most spec-scrutinised MTAs alive, and one of the four the conformance suite is
calibrated against. This run uses a **natively-installed Exim 4.99.4** (`brew install exim`)
driven as an **isolated, unprivileged test daemon** with its own config, its own spool, a high
port, no root, and **no mutation of the host's system mail**.

This is genuine ground truth: the calibration exists to test THE SUITE, not Exim. When the suite
flags Exim, the prior is that the suite is wrong.

## Result

68 cases, run against `exim-4.99.4` on 127.0.0.1:2526, fixture matching the isolated config
(`recipient@`/`postmaster@` accepted, `nobody@` → 550, `postmaster` bare accepted):

```
59 conformant, 2 non-conformant, 0 permitted-latitude, 7 inconclusive
```

**ZERO false positives.** Every finding was triaged to a real cause;
none was a suite bug or a misreading of the RFC. This is the first time the runner, reply
reader, and four-state grading have been validated end-to-end against a production MTA.

## Triage of every finding

| # | Requirement | Reported | Triage | Resolution |
|---|---|---|---|---|
| 1 | R-5321-2.3.5-g (MUST) | `RCPT TO:<postmaster>` (bare) drew `550 relay not permitted` | **Our reference config, NOT a suite bug.** The suite's expectation is correct (§4.5.1: bare postmaster MUST be accepted). My minimal ACL qualified the domain-less `postmaster` to `postmaster@exim.example.com`, which was not in `local_domains`. | Added `accept local_parts = postmaster` to the ACL; the finding **cleared** on re-run (59→ was 58 OK). Proves the finding tracked the server's real config, and the check is sound. |
| 2 | R-5321-2.3.8-a (MUST NOT) | Exim EXECUTED a bare-LF-terminated `EHLO` (replied 250) | **Genuine Exim divergence.** Byte evidence: a full multiline 250 EHLO response to a command terminated by a lone `\n`. Exim recognises bare LF as a command-line terminator, which §2.3.8-a forbids. | Recorded as a divergence (register note on R-5321-2.3.8-a). Cross-validates the identical aiosmtpd finding: real MTAs are lenient about bare-LF command terminators, the smuggling-adjacent behaviour the suite exists to surface. |
| 3 | R-5321-4.1.1.4-i (MUST NOT) | Exim EXECUTED a bare-LF-terminated `NOOP` (replied 250) | **Genuine Exim divergence**, same root cause as #2. | Same as #2. |

The 7 inconclusive are all honest: two size floors (`longLocalPartRecipient`/`longDomainRecipient`
not declared for this config), EXPN refused with 550 (Exim's anti-harvesting posture, so no
expansion can be observed), and four sink cases (no relay-to-sink configured for this run).

## What this de-risks

The runner drives a real production MTA; the reply reader frames Exim's real multiline EHLO
(SIZE, LIMITS, 8BITMIME, PIPELINING, PIPECONNECT, CHUNKING, STARTTLS, HELP) correctly; the
four-state grading makes **no false accusation** against Exim across 59 conformant behaviours;
and the two findings it does raise are a real, byte-verified divergence, not an artefact.
Alongside Postfix, mox, and aiosmtpd, the instrument is validated against four independent
implementations.

## Reproducing

```sh
brew install exim   # 4.99.4, bottled
# Isolated test daemon: own config/spool/port, unprivileged, no system mail touched.
# The config (exim-user set to the caller's uid so the daemon need not setuid;
# RFC-2606 domains; recipient@/postmaster@ accepted, nobody@ → 550, bare postmaster
# accepted) is reproduced in exim-test.conf.example here.
exim -bdf -oX 2526 -C "$PWD/exim-test.conf.example" &
node ../src/cli.ts run --config exim-local.json --verbose --now 2026-07-16T12:00:00Z
```

## Stability across code changes

Re-running this calibration against a freshly-launched native Exim 4.99.4 after substantial
server and storage work gives an **identical result**: the same two genuine bare-LF divergences
(R-5321-2.3.8-a, R-5321-4.1.1.4-i), the same zero false positives across 59 conformant Exim
behaviours. The corpus and runner are separate from the server code, so changes to the live
servers and storage do not move the calibration; this confirms that separation holds.
