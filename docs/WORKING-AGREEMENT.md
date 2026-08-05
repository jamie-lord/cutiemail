# Philosophy and working principles

This is the standard the project keeps. The heart of it is a **filter**, not
momentum. Build with care and intention. Do not move for the sake of motion. If you
plan to contribute, read this document with [CONTRIBUTING.md](../CONTRIBUTING.md).

## The mission

A correct, opinionated, self-contained "SQLite of email" in TypeScript: zero runtime
dependencies, `node:sqlite` storage, bytes-never-strings, full send + receive that works with
real clients (Thunderbird and Apple Mail, desktop and phone). Minimal-first and intentionally
scoped. This is a correctness-and-clarity project, not a feature-count project.

## The bar: clear it before touching anything

For any candidate piece of work, you should be able to say why it matters. Say it in one honest
sentence, rooted in the mission or a recorded decision. If you cannot, it probably does not
belong. Real work is one of these types:

- a genuine **correctness, security, or interop bug**, reproduced with a failing test first
- a feature already on the **intentional roadmap**, not adjacent, not "would be nice"
- a **test or verification** that catches a real, currently-uncovered defect class
- **documentation a reader actually needs** (mermaid diagrams, never ASCII art).

Everything else is out of scope unless the vision itself changes: cosmetic refactors,
edge-tinkering, and features outside the stated scope (POP3, JMAP, Sieve, ARC signing, and so
on).

## How the work is done

- **Reproduce before you fix.** A bug fix comes with a test that fails on the old code and passes
  on the new. Never write a test that passes for the wrong reason.
- **Every omission is a recorded decision, not a silent gap.** Say what was *not* done and why.
  Record it in an ADR, in the roadmap, or in the backlog's decline ledger.
- **Prove meaningful changes.** Run the suite. If the behaviour is internet-facing, verify it
  against a live deployment and record what you observe.
- **Docs are part of the change, not a follow-up.** A change can make a statement in the
  README, ARCHITECTURE, DEPLOYMENT, or TESTING wrong, stale, or newly relevant. If it does,
  correct that doc in the same change. *Correct* means fit for purpose. Restructure so the doc
  still leads with what matters. Do not just add a paragraph.

## Why it has this shape

- **The bar is a hard gate.** The four allowed categories plus the one-sentence justification are
  the anti-drift mechanism. If you cannot name the work in a sentence rooted in the mission, it
  does not happen. The truth beats invented filler. If you reach a genuine boundary and stop, that
  is the correct move, not a failure.
- **Out-of-scope is named explicitly** (POP3, JMAP, Sieve, ARC signing, multiple domains per
  instance) so an "adjacent" idea cannot pretend to be progress. You can propose a scope change.
  Open an issue first, and the decision becomes an ADR.
- **Docs are part of the increment, not a separate chore.** The core docs drifted once, precisely
  because doc upkeep was treated as optional follow-up. Make doc upkeep part of "done" for any
  meaningful change, and that drift stops. "Fit for purpose" is the bar. If a doc buries its own
  headline, restructure it, do not just add more text.

See also: [TESTING.md](TESTING.md) for what is done and what is deliberately open,
[BACKLOG.md](BACKLOG.md) for what is still open and what was deliberately declined, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit.
