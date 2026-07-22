# Philosophy and working principles

This is the standard the project holds itself to. The heart of it is a **filter**, not
momentum: careful, intentional building, not motion for its own sake. If you're
thinking about contributing, read this alongside [CONTRIBUTING.md](../CONTRIBUTING.md).

## The mission

A correct, opinionated, self-contained "SQLite of email" in TypeScript: zero runtime
dependencies, `node:sqlite` storage, bytes-never-strings, full send + receive that works with
real clients (Thunderbird and Apple Mail, desktop and phone). Minimal-first and intentionally
scoped. This is a correctness-and-clarity project, not a feature-count project.

## The bar: clear it before touching anything

For any candidate piece of work, you should be able to say, in one honest sentence rooted in the
mission or a recorded decision, why it matters. If you can't, it probably doesn't belong. Real
work is one of:

- a genuine **correctness, security, or interop bug**, reproduced with a failing test first;
- a feature already on the **intentional roadmap**, not adjacent, not "would be nice";
- a **test or verification** that catches a real, currently-uncovered defect class;
- **documentation a reader actually needs** (mermaid diagrams, never ASCII art).

Everything else stays out unless the vision itself changes: cosmetic refactors, edge-tinkering,
and features outside the stated scope (POP3, JMAP, Sieve, ARC signing, and so on).

## How the work is done

- **Reproduce before you fix.** A bug fix comes with a test that fails on the old code and passes
  on the new; never a test that passes for the wrong reason.
- **Every omission is a recorded decision, not a silent gap.** Say what was *not* done and why:
  in an ADR, in the roadmap, or in the backlog's decline ledger.
- **Prove meaningful changes.** Run the suite; for internet-facing behaviour, verify it against a
  live deployment and record what was observed.
- **Docs are part of the change, not a follow-up.** When a change makes a statement in the
  README, ARCHITECTURE, DEPLOYMENT, or TESTING wrong, stale, or newly relevant, correcting
  that doc is part of the same change; *correct* means fit for purpose (restructure so the
  doc still leads with what matters), not just appending a paragraph.

## Why it's shaped this way

- **The bar is a hard gate.** The four allowed categories plus the one-sentence justification are
  the anti-drift mechanism: work that can't be named in a sentence rooted in the mission doesn't
  happen. Naming the truth beats inventing filler; reaching a genuine boundary and stopping is the
  correct move, not a failure.
- **Out-of-scope is named explicitly** (POP3, JMAP, Sieve, ARC signing, multiple domains per
  instance) so "adjacent" ideas can't pass themselves off as progress. Proposing a scope change is
  fine: open an issue first, and the decision becomes an ADR.
- **Docs are part of the increment, not a separate chore.** The core docs drifted once, precisely
  because doc upkeep was treated as optional follow-up. Making it part of "done" for any meaningful
  change is what stops that recurring; "fit for purpose" is the bar, so a doc that buries its
  own headline gets restructured, not just topped up.

See also: [TESTING.md](TESTING.md) for what's done vs. deliberately open,
[BACKLOG.md](BACKLOG.md) for what's still open and what was deliberately declined, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit.
