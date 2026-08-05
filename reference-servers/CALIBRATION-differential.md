# Differential calibration across three independent MTAs

The suite can point at more than one server, and that also produces a differential. Where two
conformant servers disagree on a requirement, that disagreement is itself data. This run compares
**three independently-implemented mail servers, installed natively**, with no system-mail mutation.
(A fourth server, Postfix, was later added through Docker. See
[CALIBRATION-postfix.md](CALIBRATION-postfix.md).)

| Server | What it is | How run |
|---|---|---|
| **Exim 4.99.4** | One of the two canonical reference MTAs (C) | `brew install exim`, isolated unprivileged daemon (see [CALIBRATION-exim.md](CALIBRATION-exim.md)) |
| **mox 0.0.15** | Modern full-featured MTA (Go), the implementation this project's framing most resembles | `brew install mox`, `mox localserve` throwaway test server |
| **aiosmtpd 1.4.6** | Permissive asyncio SMTP server (Python) | venv (see [CALIBRATION-aiosmtpd.md](CALIBRATION-aiosmtpd.md)) |

## Per-server result: ZERO false positives against all three

```
exim-4.99.4:   59 conformant, 2 non-conformant, 0 latitude,  7 inconclusive
mox-0.0.15:    37 conformant, 2 non-conformant, 1 latitude, 28 inconclusive
aiosmtpd-1.4.6: 59 conformant, 4 non-conformant, 0 latitude,  6 inconclusive (STARTTLS on)
```

> The Exim and mox rows each sum to 68 (the suite size at the time). But the aiosmtpd
> STARTTLS-on row sums to 69. This is not a double-count. That figure was captured against
> the **69-case** suite, after the `mail-resets-prior-recipient-state` case (R-5321-3.3-b)
> was added (see [CALIBRATION-aiosmtpd.md](CALIBRATION-aiosmtpd.md)). The Exim and mox
> rows come from the earlier 68-case suite. The extra case (R-5321-3.3-b) grades inconclusive
> against aiosmtpd, so it lands in that row's inconclusive count. Re-run Exim and mox against
> the current corpus to bring all three rows onto the same suite size.

Every finding on every server traced to a genuine cause. The suite made **no false
accusation against any of the three independent implementations**. mox's high inconclusive count is
honest. `mox localserve` rejects the test MAIL FROM domain (`conformance-suite.invalid`) with a
policy 550. So its transaction and delivery tests cannot proceed. This is a conformant
anti-spoofing choice, and the suite correctly does not convict it.

## The headline cross-validation: bare-LF

**All three servers honour a bare-LF-terminated command** (R-5321-2.3.8-a and R-5321-4.1.1.4-i,
both MUST NOT). Exim, mox, and aiosmtpd each replied `250` to a command ended by a lone `\n`. When
three independent implementations agree, that is strong evidence. The finding is real, not a suite
artefact. It also shows that production MTAs widely relax this MUST NOT for command terminators.
This is the smuggling-adjacent leniency that the suite exists to surface. aiosmtpd additionally
accepts NUL/BEL control octets in commands (R-5321-4.1.2-j/-n). Exim and mox reject those octets, a
real strictness difference.

A fourth confirmation followed (2026-07-22). Postfix 3.7.11 also honours the bare-LF command
terminator, and it also accepts a BEL octet in the MAIL local-part. So the control-octet split is
now 2-lenient (aiosmtpd, Postfix) and 2-strict (Exim, mox). See
[CALIBRATION-postfix.md](CALIBRATION-postfix.md).

## The differential matrix (Exim × mox)

```
DIVERGENCES (1), where servers disagree:
  R-5321-4.1.1-a (SHOULD): exim-4.99.4=OK  mox-0.0.15=~
```

The two servers **agree** on both bare-LF findings (both non-conformant). Their one substantive
divergence is a SHOULD, R-5321-4.1.1-a: "SMTP receivers SHOULD tolerate trailing white space
before the terminating CRLF". Exim tolerates it (conformant). mox declines it (permitted-latitude).
This is a real, benign interoperability difference. It is exactly the data that the differential
view exists to produce, and neither side is scored as a fault.

## Two real robustness bugs this run found in the SUITE

The run against mox surfaced two genuine bugs that a synthetic mutant never could:

1. **`runner.ts` withDeadline() unref'd the per-case deadline timer.** A case whose body hung
   with no other active handle let Node treat the event loop as empty. Node then exited SILENTLY
   with code 0 before the deadline fired, and the entire run vanished with no report. The fix
   removes the `unref()`. The deadline now always fires and grades a hung case inconclusive.
2. **`cli.ts` called `exit()`**, which truncated buffered stdout on a pipe or file. The fix
   switches to `process.exitCode`.

This is why the suite is calibrated against real software. These are exactly the class of bug that
the mutant (the project's own code) structurally cannot reveal.

## Status

The differential covers four independent MTAs (Postfix, Exim, mox, aiosmtpd) with zero false
positives. Exim, mox, and aiosmtpd use native installs, and Postfix uses Docker (see
[CALIBRATION-postfix.md](CALIBRATION-postfix.md)). Only an OpenSMTPD or Stalwart/Maddy run remains
as optional corroboration. It is not blocking.
