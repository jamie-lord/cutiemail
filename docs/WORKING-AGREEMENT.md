# Working agreement

This is the standing goal prompt for autonomous work on this project. Paste the
block below when you want work to continue on its own — it keeps the effort on
what genuinely serves the mission, and off busywork. The heart of it is the
**filter**, not momentum: the point is careful, intentional building, not motion
for its own sake.

## The prompt

```
Keep building the mail server (/Users/jamie/Repos/mail) — but only on work that
genuinely earns its place. The mission and philosophy we've settled on are the
filter; hold to them. Start by re-reading the vision and roadmap (the mail-server
memory, project_mail_server_vision, docs/TESTING-ROADMAP.md) and the recorded
decisions, so you're anchored and don't drift.

THE MISSION. A correct, opinionated, self-contained "SQLite of email" in TypeScript:
zero runtime dependencies, node:sqlite storage, bytes-never-strings, full send +
receive that works with real clients (Thunderbird and Apple Mail, desktop and
phone). Minimal-first and intentionally scoped. This is a correctness-and-clarity
project, not a feature-count project.

THE BAR — clear it before you touch anything. For any candidate piece of work you
must be able to say, in one honest sentence rooted in the vision or a prior
decision, why it matters. If you can't, don't do it. Real work is one of:
  - a genuine correctness, security, or interop bug (reproduce it with a failing
    test first);
  - a feature already on the intentional roadmap — not adjacent, not "would be nice";
  - a test or verification that catches a real, currently-uncovered defect class;
  - documentation a reader actually needs (mermaid diagrams, never ASCII art).
Everything else is off-limits unless the vision itself changes: cosmetic refactors,
edge-tinkering, re-auditing code already covered, redundant re-runs, and features
outside the stated scope (POP3, JMAP, Sieve, ARC signing, and so on).

HOW YOU WORK, EVERY TIME. Reproduce a bug with a test before fixing it; never write
a test that passes for the wrong reason. Every omission is a recorded decision, not
a silent gap — say what you did NOT do and why. When you change something meaningful,
prove it: run the suite, and for internet-facing behaviour verify it live against the
box and report what you observed. Favour the adversarial loop that works — build a
defensible increment, have an independent reviewer try to break it, reproduce every
real finding, fix, live-verify. Keep the core docs true as you go: when a change makes
a statement in the README, ARCHITECTURE, DEPLOYMENT, or TESTING-ROADMAP wrong, stale,
or newly-relevant, correcting that doc is part of the same increment, not a later
clean-up — and correct means fit for purpose (restructure so the doc still leads with
what matters), not just appending a paragraph. Commit real increments straight to main
as Jamie Lord (no Claude attribution); committing is authorised, pushing and
destructive or outward-facing actions are not.

DON'T MANUFACTURE WORK. If you catch yourself doing something to look busy —
churning the scratchpad, re-running a green suite, reversing a scope decision just to
have a task, piling on a feature the vision didn't ask for — stop and don't. Naming
the truth beats inventing filler. When you reach a genuine boundary (the next real
work needs a fresh focused session, an external dependency, or a product call from
me), say so plainly: lay out the two or three genuinely-worthy options with their
rationale and rough cost, and either take the best-justified one or hand me the
decision. Pausing at a real boundary is correct; padding to avoid pausing is not.

I'd rather you do one carefully-reasoned, well-verified thing than five hurried ones.
```

## Why it's shaped this way

- **"Never manufacture" replaces "never stop."** Pressure to never pause is what
  nudges toward busywork; here, pausing at a genuine boundary is the correct move,
  and only inventing filler is a failure. To make it fully autonomous (never hand
  the decision back), drop the "or hand me the decision" clause.
- **The bar is a hard gate.** The four allowed categories plus the one-sentence
  justification test are the anti-drift mechanism: work that can't be named in a
  sentence rooted in the vision doesn't happen.
- **Out-of-scope is named explicitly** (POP3, JMAP, Sieve, ARC, full PSL) so
  "adjacent" ideas can't pass themselves off as progress.
- **Docs are part of the increment, not a separate chore.** The core docs drifted
  once (the README led with the test suite while claiming DKIM and the retry queue
  didn't exist yet) precisely because doc upkeep was treated as optional follow-up.
  Making it part of "done" for any meaningful change is what stops that recurring —
  and "fit for purpose" is the bar, so a doc that now buries its own headline gets
  restructured, not just topped up.

See also: [TESTING-ROADMAP.md](TESTING-ROADMAP.md) for what's done vs. deliberately
open, [BACKLOG.md](BACKLOG.md) for the evidence-based queue of what's next, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit.
