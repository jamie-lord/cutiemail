# Reference servers and calibration

These are the suite's **ground truth**, not servers under test. Postfix and Exim are the
most spec-scrutinised MTAs in existence. The calibration run exists to test THE SUITE, not
them: when the suite reports a violation against Postfix, the overwhelming prior is that the
suite is wrong.

## Why calibration is not optional

The suite's runner is our own code, and calibration (task #23) is the only thing standing
between us and confidently reporting our own defects as other people's non-conformance. A
conformance suite that has never been pointed at a known-good server is an untested
instrument. Until this passes, no result the suite produces should be trusted or published.

## Running it

Requires a running Docker daemon.

```sh
cd reference-servers
docker compose up -d
# give the servers a few seconds to accept connections
node ../src/cli.ts run --config postfix.json --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node ../src/cli.ts run --config exim.json    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose down
```

## The triage discipline

Every reported finding against a reference server MUST be triaged to exactly one of:

1. **Our bug** — the test, the reply reader, or the runner is wrong. Fix the suite. This is
   the expected outcome for most early findings.
2. **Our misreading of the RFC** — the test asserts something RFC 5321 does not require
   (a false positive: asserting an exact code where the spec permits a class, assuming an
   optional behaviour). Fix the test AND the register note that misled it.
3. **A genuine divergence** — Postfix or Exim really does deviate here. Rare, and
   extraordinary claims need the transcript as evidence. Record it as a register `bisNote`
   or a divergence note; do NOT quietly keep a test that fails a reference server without
   this justification.

A finding with no completed triage is a blocker. The suite is not trustworthy while one
exists.

## What a healthy calibration looks like

- Zero `non-conformant` findings against either server that survive triage as our bug or
  misreading — i.e. every red is either fixed or documented as a real divergence.
- A meaningful number of `inconclusive` results is EXPECTED and fine: they mark requirements
  gated on fixtures these minimal reference configs don't provide (a rejected recipient, a
  quota, a relay domain). The coverage report shows which.
- The `permitted-latitude` count reflects SHOULDs these servers decline — also fine, and
  itself interesting data for the matrix.

## Version pinning

Both images are pinned. The matrix report stamps the version into every result, so a run's
provenance is unambiguous — the flaw that let Dovecot's published imaptest table rot 14 years
while looking current. Bump versions deliberately and re-triage; a new MTA version can change
conformant behaviour.

## Note on the images

`boky/postfix` and `exim/exim4` are convenience images; their exact Postfix/Exim point
release can drift within a tag. For a publishable calibration, pin to a digest
(`image: boky/postfix@sha256:...`) and record it. The `version` field in the JSON configs is
a human label — reconcile it with the actual `postconf mail_version` / `exim -bV` output on
first run and correct it.
