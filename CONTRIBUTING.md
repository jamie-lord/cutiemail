# Contributing

Thanks for looking at cutiemail. It's an opinionated, correctness-first "SQLite of email": small,
self-contained, and deliberately scoped. Contributions are welcome, but the project is shaped by a
strong philosophy — reading it first will save us both time.

- **The mission and the bar:** [docs/WORKING-AGREEMENT.md](docs/WORKING-AGREEMENT.md).
- **What's done vs. deliberately left open:** [docs/TESTING.md](docs/TESTING.md).
- **How the pieces fit:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Why things are the way they are:** [docs/decisions/](docs/decisions/) (the ADRs).

## What makes a good contribution

This is a correctness-and-clarity project, not a feature-count one. Before opening a PR, be able to
say in one honest sentence — rooted in the mission or a recorded decision — why the change earns its
place. Work that clears the bar is one of:

- a genuine **correctness, security, or interop bug** — reproduce it with a failing test *first*;
- a feature already on the **intentional roadmap** (not adjacent, not "would be nice");
- a **test or verification** that catches a real, currently-uncovered defect class;
- **documentation a reader actually needs.**

Some things are intentionally **out of scope** and won't be merged unless the vision itself changes:
POP3, JMAP, Sieve, ARC *signing*, and other MTA features. If you want to propose a scope change,
open an issue to discuss it before writing code — the answer is often "recorded as a deliberate
omission," and the decision belongs in an ADR.

For anything non-trivial, **open an issue first** so we can agree it's in scope before you invest
the work.

## The non-negotiables

These are the invariants the whole codebase is built on. A change that breaks one won't be merged:

- **Zero runtime dependencies.** The only things in `node_modules` are the type-checker and Node's
  own types (`devDependencies`). No mail libraries — the SMTP/IMAP engines, MIME parser, and crypto
  are hand-built. If you reach for a dependency, that's the signal to reconsider.
- **Bytes, never strings.** Message content is a `Buffer` from the socket to the SQLite `BLOB` and
  back — never round-tripped through a JavaScript string. That rule is what makes a delivered
  message readable back byte-exact.
- **No build step.** Node runs the `.ts` files directly (≥ 22.18, type stripping), so every
  construct must be *erasable* — `erasableSyntaxOnly` makes enums, namespaces, and TS parameter
  properties compile errors. Declare class fields explicitly.
- **`node:sqlite` storage**, one database per account plus a control database.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are
  on; `npm run typecheck` must be clean.

## How to develop

```sh
git clone https://github.com/jamie-lord/cutiemail
cd cutiemail
npm install        # dev tooling only (the type-checker); no runtime deps
npm test           # the whole suite (node --test), including the negative-control proofs
npm run typecheck  # tsc --noEmit; strict
npm start          # run the daemon locally with dev-friendly defaults
node src/cli.ts coverage   # the SMTP conformance suite's coverage report
```

Run **both `npm test` and `npm run typecheck`** before submitting; both must be green.

## Testing discipline

Correctness is the point, so the test bed is held to a high bar:

- **Reproduce before you fix.** A bug fix comes with a test that fails on the old code and passes on
  the new — no fix without a regression test.
- **No test that passes for the wrong reason.** The conformance checks are each run against a
  [mutant server](src/testing/mutant-server.ts) with a switchable defect, proving the check *detects
  its own violation*. If you add a check, prove it can fail. To add a corpus module, follow the
  contract in [src/corpus/AUTHORING.md](src/corpus/AUTHORING.md).
- **The persistent store is proven against a reference model** — the SQLite mailbox and an in-memory
  reference are driven through one shared invariant harness and must agree operation-for-operation.
  Storage-affecting changes must keep that parity.
- **Say what you did *not* do.** Every omission is a recorded decision, not a silent gap.

## Decisions and docs are part of the change

- A meaningful design choice gets an **ADR** in `docs/decisions/` (see the existing ones for the
  shape) — that's how "why" survives.
- When a change makes a statement in the README, ARCHITECTURE, DEPLOYMENT, or TESTING wrong,
  stale, or newly relevant, **fixing that doc is part of the same change**, not a follow-up. Use
  **mermaid** for diagrams, never ASCII art.

## Commits and pull requests

- Keep PRs small and reviewable — one well-reasoned change beats a sprawling one.
- Write commit messages that explain **why**, not just what.
- Describe how you verified the change; for internet-facing behaviour, say what you observed.

## Security issues

Please **don't** open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md) for
private reporting.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
