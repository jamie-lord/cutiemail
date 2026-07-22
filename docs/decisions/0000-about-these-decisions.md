# 0000 — About these decision records

cutiemail is two things sharing one spine: a small, opinionated **mail server** ("the SQLite
of email") and an **SMTP conformance suite** that the server is tested against. The server is
the product; the suite is how its correctness is proven and how any other MTA can be measured.
The records here are Architecture Decision Records (ADRs) — each captures one choice and the
reasoning behind it, so the "why" survives.

This page orients a first-time reader: it defines the recurring vocabulary once, then groups
the records.

## Core terms

- **Register of requirements** — the machine-readable list of a spec's normative statements
  (each MUST / SHOULD / MAY), quoted **verbatim** from the vendored RFC text and tagged with
  its RFC 2119 level and the party it binds (sender or receiver). A build-time gate checks each
  quote against the pinned RFC, so the register can never drift from the spec it cites.
- **Corpus** — the collection of concrete test cases, each citing a register requirement by ID.
  The register says *what the spec requires*; the corpus is *the cases that exercise it*.
- **Mutant server** — a deliberately defective server with switchable, individually named
  defects. Every conformance check is run against it to prove the check **detects its own
  violation**: a check that has never been shown to fail counts as half-covered, not covered.
  (The input-parsing corpora use the same idea with mutated *inputs* rather than a mutant
  server.)
- **Four-state result taxonomy** — a case resolves to one of **conformant**,
  **non-conformant**, **permitted-latitude**, or **inconclusive**. Most of RFC 5321 is
  SHOULD/MAY, so a declined SHOULD is recorded *latitude*, not a failure; only a violated MUST
  is a finding, and a case the suite cannot observe is *inconclusive* rather than silently
  dropped. This keeps the honest denominator visible.

For the full testing model see [TESTING.md](../TESTING.md).

## The records, grouped

**The conformance suite (0001–0008)** — the spec baseline, the runner, and the surfaces the
suite covers:

- [0001](0001-spec-baseline.md) — Spec baseline: RFC 5321 is normative; 5321bis is a clarification source
- [0002](0002-own-runner-not-mpt.md) — Write our own runner in TypeScript; do not adopt Apache James MPT
- [0003](0003-skeleton-scope.md) — Project skeleton: what we deliberately left out
- [0004](0004-5321bis-deltas.md) — RFC 5321bis deltas that matter for the corpus
- [0005](0005-dot-stuffing-deferred.md) — DATA transparency / dot-stuffing is deferred, with reason
- [0006](0006-starttls-injection.md) — STARTTLS command-injection, and admitting RFC 3207 to the register
- [0007](0007-modern-opinionated-scope.md) — A modern, opinionated server: the scope cuts, recorded
- [0008](0008-outbound-client-harness.md) — The outbound client harness, and the `wire-client` testability kind

**The mail server (0009–0020)** — the product decisions: storage, delivery, auth, and operations:

- [0009](0009-multi-account-per-user-database.md) — Multi-account: one SQLite database per user
- [0010](0010-dmarc-quarantine-to-junk.md) — Inbound DMARC enforcement: quarantine to Junk, never hard-reject
- [0011](0011-arc-inbound-verification.md) — ARC inbound verification with a trusted-sealer DMARC override
- [0012](0012-account-provisioning-cli.md) — Accounts are provisioned by CLI; env vars seed create-only
- [0013](0013-no-http-listener.md) — No HTTP listener: MTA-STS policy generated, hosted externally; autoconfig cut
- [0014](0014-aliases-and-subaddressing.md) — Aliases and subaddressing
- [0015](0015-submission-sender-authorization.md) — Submission sender-authorization (send-as)
- [0016](0016-rename-inbox-fresh-target.md) — Renaming INBOX produces a fresh mailbox
- [0017](0017-app-specific-passwords.md) — App-specific passwords
- [0018](0018-selftest-command.md) — `selftest` end-to-end command
- [0019](0019-outbound-hold-mode.md) — `MAIL_OUTBOUND=hold`: the outbound sink mode
- [0020](0020-container-image.md) — A container image (Dockerfile + compose)
