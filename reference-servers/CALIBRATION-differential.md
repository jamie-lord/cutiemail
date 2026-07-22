# Differential calibration across three independent MTAs (2026-07-16), task #24

With Docker still non-functional here, the differential run (#24) was done against **three
independently-implemented mail servers installed natively**, with no Docker and no system-mail
mutation:

| Server | What it is | How run |
|---|---|---|
| **Exim 4.99.4** | One of the two canonical reference MTAs (C) | `brew install exim`, isolated unprivileged daemon (see [CALIBRATION-exim.md](CALIBRATION-exim.md)) |
| **mox 0.0.15** | Modern full-featured MTA (Go), the project Jamie's own framing most resembles | `brew install mox`, `mox localserve` throwaway test server |
| **aiosmtpd 1.4.6** | Permissive asyncio SMTP server (Python) | venv (see [CALIBRATION-aiosmtpd.md](CALIBRATION-aiosmtpd.md)) |

## Per-server result: ZERO false positives against all three

```
exim-4.99.4:   59 conformant, 2 non-conformant, 0 latitude,  7 inconclusive
mox-0.0.15:    37 conformant, 2 non-conformant, 1 latitude, 28 inconclusive
aiosmtpd-1.4.6: 59 conformant, 4 non-conformant, 0 latitude,  6 inconclusive (STARTTLS on)
```

> The Exim and mox rows each sum to 68 (the suite size at the time), but the aiosmtpd
> STARTTLS-on row sums to 69. This is not a double-count: that figure was captured against
> the **69-case** suite, after the `mail-resets-prior-recipient-state` case (R-5321-3.3-b)
> was added (see [CALIBRATION-aiosmtpd.md](CALIBRATION-aiosmtpd.md)). The Exim and mox
> rows are from the earlier 68-case suite. The extra case (R-5321-3.3-b) grades inconclusive
> against aiosmtpd, so it lands in that row's inconclusive count. Re-run Exim and mox against
> the current corpus to bring all three rows onto the same suite size.

Every finding on every server was triaged to a genuine cause. The suite made **no false
accusation against any of three independent implementations**. mox's high inconclusive count is
honest: `mox localserve` rejects the test MAIL FROM domain (`conformance-suite.invalid`) with a
policy 550, so its transaction/delivery tests cannot proceed, a conformant anti-spoofing choice
the suite correctly does not convict.

## The headline cross-validation: bare-LF

**All three servers honour a bare-LF-terminated command** (R-5321-2.3.8-a and R-5321-4.1.1.4-i,
both MUST NOT): Exim, mox, and aiosmtpd each replied `250` to a command ended by a lone `\n`.
Three independent implementations agreeing is strong evidence the finding is real, not a suite
artefact, and that this MUST NOT is widely relaxed by production MTAs for command terminators
(the smuggling-adjacent leniency the suite exists to surface). aiosmtpd additionally accepts
NUL/BEL control octets in commands (R-5321-4.1.2-j/-n); Exim and mox reject those, a real
strictness difference.

Later strengthened to four (2026-07-22): Postfix 3.7.11 also honours the bare-LF command
terminator, and also accepts a BEL octet in the MAIL local-part, so the control-octet split is now
2-lenient (aiosmtpd, Postfix) / 2-strict (Exim, mox). See
[CALIBRATION-postfix.md](CALIBRATION-postfix.md).

## The differential matrix (Exim × mox)

```
DIVERGENCES (1), where servers disagree:
  R-5321-4.1.1-a (SHOULD): exim-4.99.4=OK  mox-0.0.15=~
```

The two servers **agree** on both bare-LF findings (both non-conformant). Their one substantive
divergence is a SHOULD, R-5321-4.1.1-a, "SMTP receivers SHOULD tolerate trailing white space
before the terminating CRLF": Exim tolerates it (conformant), mox declines (permitted-latitude).
A real, benign interoperability difference, exactly the data the differential view exists to
produce, and correctly NOT scored as a fault on either side.

## Two real robustness bugs this run found in the SUITE

Pointing the runner at mox surfaced two genuine bugs that a synthetic mutant never could:

1. **`runner.ts` withDeadline() unref'd the per-case deadline timer.** A case whose body hung
   with no other active handle let Node treat the event loop as empty and exit SILENTLY with
   code 0 before the deadline fired, the entire run vanishing with no report. Removed the
   `unref()`; the deadline now always fires and grades a hung case inconclusive.
2. **`cli.ts` called `exit()`**, truncating buffered stdout on a pipe/file. Switched to
   `process.exitCode`.

This is why we calibrate against real software: these are exactly the
class of bug the mutant (my own code) structurally cannot reveal.

## Status

Tasks #23 (Exim + Postfix) and #24 (Exim × mox × aiosmtpd differential) are **done**: Exim, mox,
and aiosmtpd via native installs, Postfix via Docker (see
[CALIBRATION-postfix.md](CALIBRATION-postfix.md)). Four independent MTAs, zero false positives.
Only Stalwart/Maddy remains as optional corroboration (no Homebrew formula, would need fetching);
it is not blocking.
