# Smoke-calibration against aiosmtpd (2026-07-16)

A **partial, honestly-caveated calibration** run while the Postfix/Exim ground-truth run
(task #23) is blocked on Docker registry egress (see [README.md](README.md)). This is **not**
a substitute for #23 and does not close it.

## What this is, and what it is not

`aiosmtpd` 1.4.6 is a third-party asyncio SMTP server — genuinely independent code, **not**
mine and **not** a spec-scrutinised MTA. Its value here is narrow but real: pointing the suite
at software I did not write exercises the runner, the reply reader, and the grading engine
end-to-end in a way the mutant server (my own code) structurally cannot. It catches the class
of bug where *the instrument* mis-frames or mis-judges a real server.

Its limits are equally real: aiosmtpd is a permissive debugging server. It exercises the
*lax* paths, not the hardened ones a production MTA defends, so a clean-ish run here says
little about the strict-rejection requirements Postfix/Exim would drive. **Ground-truth
calibration still requires #23.**

## Result

68 cases, run `2026-07-16T12:00:00Z`, against `aiosmtpd-1.4.6` on 127.0.0.1:2600 with a
handler matching richFixture (`recipient@`/`postmaster@` accepted, `nobody@` → 550):

```
55 conformant, 4 non-conformant, 0 permitted-latitude, 9 inconclusive
```

**The number that matters: zero false positives.** Every one of the 4 findings is a genuine
aiosmtpd non-conformance, independently reproduced with a raw socket (below). The 55
conformant cases were correctly *not* flagged, and the 9 inconclusive are all honest
(missing `longLocalPartRecipient`/`longDomainRecipient` fixtures; STARTTLS not advertised;
EXPN returns 502 so its buffer-effect can't be observed; 4 sink cases with no sink configured).
No finding traced to *our bug* or *our misreading* — all four are *genuine divergence*, the
triage discipline's third bucket.

## Triage of every finding (all CONFIRMED genuine)

| Requirement | What the suite reported | Independent raw-socket repro | Verdict |
|---|---|---|---|
| R-5321-2.3.8-a (MUST NOT) | server executed a bare-LF-terminated EHLO (250) | `EHLO …\n` (no CR) → full `250` EHLO response | genuine — aiosmtpd honors bare LF |
| R-5321-4.1.1.4-i (MUST NOT) | server executed a bare-LF NOOP (250) | `NOOP\n` → `250 OK` | genuine — same root cause |
| R-5321-4.1.2-j (MUST NOT) | MAIL with a NUL octet in the local-part accepted (250) | EHLO, then `MAIL FROM:<pr\0obe@…>` → `250 OK` | genuine — no control-octet validation |
| R-5321-4.1.2-n (MUST) | command with a BEL (0x07) octet accepted, not rejected 501 | `EHLO conf\x07erence` → full `250` response | genuine — same root cause |

The bare-LF findings are the notable ones: aiosmtpd honors `<LF>` as a line terminator
(asyncio's `StreamReader.readline` splits on `\n`), which is precisely the SMTP-smuggling
primitive the flagship CRLF corpus exists to catch. The suite caught it in real, shipping,
widely-deployed software on the first run — the strongest possible evidence the smuggling
tests have teeth beyond the mutant.

### A triage note on method (recorded because it nearly misled me)

The first raw-socket repro of the NUL finding returned `503 send HELO first`, appearing to
contradict the suite's `250`. That was a bug in the *repro harness* (it wrote MAIL before the
EHLO reply had been drained), not in the suite. A careful sequential repro that fully drains
each reply before sending the next confirmed `250 OK`. Lesson for #23's triage: a
disagreement between a hand-repro and the suite is, until proven otherwise, a bug in the
hand-repro — the runner sequences correctly.

## Reproducing

```sh
cd reference-servers
# isolated venv — PEP 668 blocks a system install:
python3 -m venv venv && ./venv/bin/pip install aiosmtpd
# target handler (aiosmtpd-target.py): accept recipient@/postmaster@, 550 nobody@, listen 127.0.0.1:2600
./venv/bin/python aiosmtpd-target.py &
node ../src/cli.ts run --config aiosmtpd.json --verbose --now 2026-07-16T12:00:00Z
```

Both `aiosmtpd-target.py` and `aiosmtpd.json` live here in `reference-servers/`. They use
only RFC 2606 reserved domains.

## What this de-risks, and what it leaves open

De-risked: the runner drives real independent software end-to-end; the reply reader frames a
real multiline EHLO correctly; the four-state grading produces no false accusation against a
real server; fixture/extension/sink gating yields honest inconclusive rather than false
pass/fail.

Still open (task #23): a permissive server can't exercise the strict-rejection and
hardened-path requirements. Only Postfix/Exim — which *do* reject bare-LF, *do* enforce
sizes, *do* run STARTTLS — will calibrate those. Run #23 on a host with working Docker egress.

## Independently reproduced (2026-07-16)

Re-run from scratch in a fresh venv (`aiosmtpd 1.4.6`, a different install from the one above)
against the same target and config: **identical result — 68 cases, the same 4 non-conformant
findings (R-5321-2.3.8-a, 4.1.1.4-i, 4.1.2-j, 4.1.2-n), the same 9 inconclusive, 55
conformant, zero false positives.** The transcripts confirm each finding at the byte level (a
bare-LF EHLO drawing a full `250` extension list, `250 OK` to a NUL-bearing MAIL). This is the
project's "assume we are wrong until proven" rule applied to its own calibration record: the
claim above is confirmed by a second independent run, not taken on faith.

## Broadened run — and a real bug it surfaced in the config parser (2026-07-16)

Extending the run was itself worth it: adding `longLocalPartRecipient` and
`longDomainRecipient` to `aiosmtpd.json` (aiosmtpd accepts any recipient, so it can exercise
the §4.5.3.1 size floors) **surfaced a genuine defect in `config.ts`** — the parser never read
those two fields, so an operator who declared them got them silently dropped and the floor
tests stayed inconclusive with no error. Fixed (both fields now parsed; the round-trip test
made exhaustive so a future unwired `Fixture` field fails the build). This is exactly the class
of instrument bug a real calibration catches and the mutant (my own code) cannot.

After the fix, the broadened run over the **69** current cases (the new
`mail-resets-prior-recipient-state`, R-5321-3.3-b, is included) gives **57 conformant, 4
non-conformant (unchanged), 8 inconclusive, still zero false positives.** The two size floors
now grade: aiosmtpd **accepts** a 64-octet local-part and a 245-octet domain (conformant with
§4.5.3.1.1-a / §4.5.3.1.2-a). R-5321-3.3-b is inconclusive here — aiosmtpd refuses the nested
MAIL with 503, the conformant §4.1.4-o path, which the test correctly reports as "reset not
exercised" rather than a false finding: independent confirmation that its isolate-the-variable
gate works against real software.
