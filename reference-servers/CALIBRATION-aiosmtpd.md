# Calibration against aiosmtpd 1.4.6

This is one of the four independent SMTP implementations that the conformance suite is calibrated
against. The others are Postfix, Exim, and mox (see [README.md](README.md)).

## What this is, and what it is not

`aiosmtpd` 1.4.6 is a third-party asyncio SMTP server. It is independent code, and it is **not** a
spec-scrutinised MTA. Its value is narrow but real. When you point the suite at software written
independently of this project, it exercises the runner, the reply reader, and the grading engine
end-to-end. The mutant server (this project's own code) structurally cannot do this. aiosmtpd
catches the class of bug where the instrument mis-frames or mis-judges a real server.

Its limits are equally real. aiosmtpd is a permissive debugging server. It exercises the *lax*
paths, not the hardened paths a production MTA defends. So a clean-ish run here says little about
the strict-rejection requirements that Postfix and Exim drive. The Postfix and Exim calibrations
cover those requirements.

## Result

68 cases, run `2026-07-16T12:00:00Z`, against `aiosmtpd-1.4.6` on 127.0.0.1:2600 with a
handler matching richFixture (`recipient@`/`postmaster@` accepted, `nobody@` → 550):

```
55 conformant, 4 non-conformant, 0 permitted-latitude, 9 inconclusive
```

**Zero false positives.** Every one of the 4 findings is a genuine aiosmtpd non-conformance. A raw
socket reproduced each one independently (below). The suite correctly did *not* flag the 55
conformant cases. The 9 inconclusive results are all honest: missing
`longLocalPartRecipient`/`longDomainRecipient` fixtures, STARTTLS not advertised, EXPN returns 502
so its buffer-effect cannot be observed, and 4 sink cases with no sink configured. No finding
traced to *our bug* or *our misreading*. All four are a *genuine divergence*, the triage
discipline's third bucket.

## Triage of every finding (all CONFIRMED genuine)

| Requirement | What the suite reported | Independent raw-socket repro | Verdict |
|---|---|---|---|
| R-5321-2.3.8-a (MUST NOT) | server executed a bare-LF-terminated EHLO (250) | `EHLO …\n` (no CR) → full `250` EHLO response | genuine: aiosmtpd honours bare LF |
| R-5321-4.1.1.4-i (MUST NOT) | server executed a bare-LF NOOP (250) | `NOOP\n` → `250 OK` | genuine: same root cause |
| R-5321-4.1.2-j (MUST NOT) | MAIL with a NUL octet in the local-part accepted (250) | EHLO, then `MAIL FROM:<pr\0obe@…>` → `250 OK` | genuine: no control-octet validation |
| R-5321-4.1.2-n (MUST) | command with a BEL (0x07) octet accepted, not rejected 501 | `EHLO conf\x07erence` → full `250` response | genuine: same root cause |

The bare-LF findings are the notable ones. aiosmtpd honours `<LF>` as a line terminator (asyncio's
`StreamReader.readline` splits on `\n`). This is precisely the SMTP-smuggling primitive that the
flagship CRLF corpus exists to catch. The suite caught it in real, shipping, widely-deployed
software on the first run. This is the strongest possible evidence that the smuggling tests have
teeth beyond the mutant.

### A triage note on method

The first raw-socket repro of the NUL finding returned `503 send HELO first`. This appeared to
contradict the suite's `250`. But the cause was a bug in the *repro harness*, not in the suite: it
wrote MAIL before it drained the EHLO reply. A careful sequential repro that fully drains each
reply before it sends the next confirmed `250 OK`. The lesson for triage is this: until you prove
otherwise, a disagreement between a hand-repro and the suite is a bug in the hand-repro, because
the runner sequences correctly.

## Reproducing

```sh
cd reference-servers
# isolated venv (PEP 668 blocks a system install):
python3 -m venv venv && ./venv/bin/pip install aiosmtpd
# target handler (aiosmtpd-target.py): accept recipient@/postmaster@, 550 nobody@, listen 127.0.0.1:2600
./venv/bin/python aiosmtpd-target.py &
node ../src/cli.ts run --config aiosmtpd.json --verbose --now 2026-07-16T12:00:00Z
```

Both `aiosmtpd-target.py` and `aiosmtpd.json` live here in `reference-servers/`. They use
only RFC 2606 reserved domains.

## What this de-risks, and what it leaves to the stricter MTAs

De-risked: the runner drives real independent software end-to-end. The reply reader frames a real
multiline EHLO correctly. The four-state grading produces no false accusation against a real
server. Fixture, extension, and sink gating yields honest inconclusive results rather than false
pass/fail.

Left to the stricter MTAs: a permissive server cannot exercise the strict-rejection and
hardened-path requirements. Postfix and Exim calibrate those requirements. They *do* reject
bare-LF, they *do* enforce sizes, and they *do* run STARTTLS. See their write-ups.

## Independently reproduced

A re-run from scratch in a fresh venv (`aiosmtpd 1.4.6`, a different install from the one above)
used the same target and config. It gave an **identical result: 68 cases, the same 4
non-conformant findings (R-5321-2.3.8-a, 4.1.1.4-i, 4.1.2-j, 4.1.2-n), the same 9 inconclusive, 55
conformant, and zero false positives.** The transcripts confirm each finding at the byte level: a
bare-LF EHLO draws a full `250` extension list, and a NUL-bearing MAIL draws `250 OK`. This applies
the project's "assume we are wrong until proven" rule to its own calibration record. A second
independent run confirms the claim above. It is not taken on faith.

## Broadened run, and a real bug it surfaced in the config parser

Two fixtures, `longLocalPartRecipient` and `longDomainRecipient`, were added to `aiosmtpd.json`.
(aiosmtpd accepts any recipient, so it can exercise the §4.5.3.1 size floors.) This **surfaced a
genuine defect in `config.ts`**. The parser never read those two fields. So an operator who
declared them lost them silently, and the floor tests stayed inconclusive with no error. The fix
now parses both fields. The round-trip test is now exhaustive, so a future unwired `Fixture` field
fails the build. This is exactly the class of instrument bug that a real calibration catches and
the mutant (this project's own code) cannot.

After the fix, the broadened run covers the **69** current cases (it includes the new
`mail-resets-prior-recipient-state`, R-5321-3.3-b). It gives **57 conformant, 4 non-conformant
(unchanged), 8 inconclusive, and still zero false positives.** The two size floors now grade.
aiosmtpd **accepts** a 64-octet local-part and a 245-octet domain (conformant with §4.5.3.1.1-a /
§4.5.3.1.2-a). R-5321-3.3-b is inconclusive here. aiosmtpd refuses the nested MAIL with 503, the
conformant §4.1.4-o path. The test correctly reports this as "reset not exercised" rather than a
false finding. This independently confirms that the isolate-the-variable gate works against real
software.

### STARTTLS enabled: the security corpus, calibrated against real TLS

Set `AIOSMTPD_CERT`/`AIOSMTPD_KEY` (see `aiosmtpd-target.py`) to make aiosmtpd advertise and honour
STARTTLS. The RFC 3207 cases then grade instead of turning inconclusive: **59 conformant, 4
non-conformant, 6 inconclusive, and zero false positives.** Both STARTTLS cases pass. aiosmtpd
advertises and honours the upgrade (§4.2.4-c). It also passes the flagship security check: it
**correctly discards plaintext pipelined across the STARTTLS boundary** (R-3207-4.2-a). It is *not*
vulnerable to the CVE-2011-0411 injection. This validates the suite's central security corpus
(including the TLS-terminating handshake path) against an independent TLS implementation, not just
the mutant. 63 of 69 cases now grade against real software. The 6 remaining inconclusive results
are all honest: the 4 sink cases with no relay, EXPN disabled → 502, and 3.3-b's conformant
nested-MAIL-503 path.

Reproduce the full run:

```sh
openssl req -x509 -newkey rsa:2048 -keyout /tmp/key.pem -out /tmp/cert.pem -days 1 \
  -nodes -subj "/CN=aiosmtpd.example.com"
AIOSMTPD_CERT=/tmp/cert.pem AIOSMTPD_KEY=/tmp/key.pem ./venv/bin/python aiosmtpd-target.py &
node ../src/cli.ts run --config aiosmtpd.json --verbose --now 2026-07-16T12:00:00Z
```
