# Calibration against Postfix 3.7.11

The fourth and most important ground-truth calibration. Postfix is the reference for the
mainstream interpretation of RFC 5321, and the suite's whole false-positive discipline was
designed around one rule: **never convict a hardened Postfix**. Until the suite had actually met
Postfix, that was an untested promise. It is now kept.

This run also does something the three earlier calibrations (Exim, mox, aiosmtpd) could not: it
points the suite at the **same binary in two configurations**, one vulnerable to SMTP smuggling
and one hardened against it, and shows the suite flags the vulnerable config and **positively
blesses** the hardened one. That is a stronger statement than "makes no false accusation against a
good server": it is "detects the CVE when present, and clears it when patched."

## How it was run

Docker, via the committed `docker-compose.yml`. The pinned image is `boky/postfix:v4.3.0`,
which is **Postfix 3.7.11**. Its default `smtpd_forbid_bare_newline` is `no`, i.e. the
pre-CVE-2023-51764 end-of-data behaviour, so the default service exercises the unmitigated
smuggling path and a second service sets `smtpd_forbid_bare_newline=yes` for the fix. The minimal
reference config sets the smtpd restriction stages to `permit` so the suite's RFC-2606 test
envelope is not rejected by policy before the protocol question under test is reached, while
`relay_restrictions` keeps open-relay refusal intact (the non-relay-domain fixture still draws a
554). `local_recipient_maps=static:all` and `mydestination=example.com` make every
local-domain recipient valid, so the size-floor fixture is a real acceptance, not a lucky 250.

```sh
cd reference-servers && docker compose up -d postfix postfix-hardened
node ../src/cli.ts run --config postfix.json          --verbose --now 2026-07-22T21:00:00Z
node ../src/cli.ts run --config postfix-hardened.json --verbose --now 2026-07-22T21:00:00Z
docker compose down
```

## Result: zero false positives, both configs

```
postfix-3.7-reference (forbid_bare_newline=no):  57 conformant, 5 non-conformant, 1 latitude, 8 inconclusive
postfix-3.7-hardened  (forbid_bare_newline=yes): 59 conformant, 3 non-conformant, 1 latitude, 8 inconclusive
```

Every finding on both runs triages to a genuine, byte-verified cause. **None is a suite bug or a
misreading of the RFC.** The one permitted-latitude case is a declined SHOULD (not a fault, exactly
as for Exim and mox). The reply reader framed Postfix's richer multiline EHLO
(`PIPELINING SIZE VRFY ETRN STARTTLS ENHANCEDSTATUSCODES 8BITMIME DSN SMTPUTF8 CHUNKING`) correctly.

## The headline: the same server, vulnerable then hardened

The two configs differ by exactly the two DATA-phase smuggling vectors. Setting
`smtpd_forbid_bare_newline=yes` moved both from **non-conformant to conformant** (OK count
56 -> 58 on the findings alone; the size-floor fixture accounts for the other +1). Nothing else
changed. The suite convicts the vulnerable Postfix on precisely the CVE and blesses the patched
one, with no collateral movement.

| Corpus case | Requirement | forbid=no (vulnerable) | forbid=yes (hardened) |
|---|---|---|---|
| `bare-lf-command-not-honoured` | R-5321-2.3.8-a (MUST NOT) | X executes bare-LF EHLO | X executes bare-LF EHLO |
| `bare-lf-line-acceptance-rejected` | R-5321-4.1.1.4-i (MUST NOT) | X executes bare-LF NOOP | X executes bare-LF NOOP |
| `lf-dot-lf-not-end-of-data` | R-5321-4.1.1.4-j (MUST NOT) | **X smuggling** | **OK defended** |
| `lf-dot-crlf-not-end-of-data` | R-5321-4.1.1.4-i (CVE-2023-51764) | **X smuggling** | **OK defended** |
| `invalid-char-command-rejected-501` | R-5321-4.1.2-n (MUST) | X accepts BEL octet | X accepts BEL octet |

The command-phase bare-LF findings do **not** clear under the mitigation, and that is correct, not
a gap in the fix: `smtpd_forbid_bare_newline` guards the message-data boundary (where smuggling
lives), while Postfix keeps accepting a bare-LF-terminated *command* line for robustness. This is
the same command-phase leniency Exim, mox, and aiosmtpd all show. Four independent MTAs now agree
that this MUST NOT is widely relaxed for command terminators, which is exactly the smuggling-adjacent
behaviour the suite exists to make visible rather than hide.

## Triage of every finding

| # | Requirement / case | Reported | Triage | Evidence |
|---|---|---|---|---|
| 1 | R-5321-2.3.8-a `bare-lf-command-not-honoured` | executed a bare-LF EHLO (250) | **Genuine divergence.** Fourth confirmation after Exim/mox/aiosmtpd; command-phase leniency Postfix keeps even when hardened. | full multiline 250 EHLO to an `EHLO ...\n` (no CR) |
| 2 | R-5321-4.1.1.4-i `bare-lf-line-acceptance-rejected` | executed a bare-LF NOOP (250) | **Genuine divergence**, same root cause as #1. | `250 2.0.0 Ok` to `NOOP\n` |
| 3 | R-5321-4.1.1.4-j `lf-dot-lf-not-end-of-data` | treated `<LF>.<LF>` as end-of-data | **Genuine, config-dependent.** Present with the shipped default; cleared to OK by `smtpd_forbid_bare_newline=yes`. The suite detects the CVE and confirms the fix. | 250 mid-DATA at the fake boundary (vulnerable); silence then clean real-EOD acceptance (hardened) |
| 4 | R-5321-4.1.1.4-i `lf-dot-crlf-not-end-of-data` | treated `<LF>.<CR><LF>` as end-of-data | **Genuine, config-dependent** (CVE-2023-51764 itself); same as #3. | same shape as #3 |
| 5 | R-5321-4.1.2-n `invalid-char-command-rejected-501` | accepted a BEL (0x07) in the MAIL local-part (250), not 501 | **Genuine divergence.** Second witness after aiosmtpd; Exim and mox reject the octet. Now 2 lenient / 2 strict across four MTAs. Not an exact-code quibble: Postfix *accepts and delivers*, so it fails "MUST reject" under any reading. | raw wire: `MAIL FROM:<pr\x07obe@...>` -> `250 2.1.0 Ok`, then `250 2.0.0 Ok: queued as CAE3D1099` |

The 8 inconclusive are all honest: two are §4.5.3.1 size floors this config cannot supply
(`longDomainRecipient` would need the long domain added to `mydestination`; only `example.com` is
local here), EXPN/HELP refused so their buffer-effect cannot be observed, and four sink cases that
need a receiving sink a black-box container does not expose. The `longLocalPartRecipient` fixture
*was* supplied (Postfix accepts a 64-octet local-part at the local domain), so that floor now
grades a real OK rather than inconclusive.

## What this de-risks, and what it does not

De-risked: the runner drives Postfix end-to-end; the reply reader frames its full ESMTP extension
list correctly; the four-state grading makes **no false accusation** across 57/59 conformant Postfix
behaviours; the smuggling corpus both convicts a vulnerable Postfix and positively clears a hardened
one; and the size-floor fixture path grades a real acceptance. Combined with Exim, mox, and aiosmtpd,
the instrument is validated against **four independent codebases**, one of them in two security
postures.

Not claimed: the black-box container cannot expose delivered message bytes, so the four sink cases
(trace-header insertion, dot-unstuffing, control-char delivery, local-part case preservation) stay
inconclusive here. They are covered against our own server by the store-level tests; a real MTA sink
is a separate, lower-value exercise.

## No server change, by design

Every Postfix finding is a place where Postfix is *more lenient* than our server: it honours
bare-LF command terminators, and it accepts a control octet our server rejects with 501. Copying any
of that would weaken us, and "don't blindly follow Postfix" is the explicit rule. Our server sits on
the strict side of all four independent MTAs on these vectors, and the full suite stays green, so
this calibration warranted a suite/documentation update and **no functional change** to the server.
