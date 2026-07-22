# 0003 — Project skeleton: what we deliberately left out

Date: 2026-07-15
Status: Accepted

## Decision

The skeleton is TypeScript + Node's built-in test runner + `tsc --noEmit` for typechecking.
Nothing else. Total runtime dependencies: **zero**. Total dev dependencies: **one** (`typescript`).

> **Amendment (2026-07-22):** `node:sqlite` has since become the core storage layer — one
> database per account plus a control database (see ADR 0009) — so the "not needed yet" note
> under *Left out on purpose* below is superseded. The dev-dependency count is now **two**
> (`typescript` and `@types/node`); runtime dependencies remain **zero**.

## Why so little

**Node 22.18+ runs TypeScript directly** via type stripping — verified with Node v22.22.0:
`node foo.ts` works with no flag. So there is no build step, no bundler, no `ts-node`, no `tsx`.
`tsc` is present only to *check* types, never to emit. `erasableSyntaxOnly` is on so that if we ever
write syntax Node can't strip (enums, namespaces, parameter properties), it fails at typecheck
rather than at runtime.

Node's built-in test runner covers what we need. A conformance suite's assertions are our own
four-state taxonomy (conformant / non-conformant / permitted-latitude / inconclusive), not
`expect().toBe()` — so a third-party assertion library would be carrying weight it doesn't pull.

## Left out on purpose

Recording these so they read as decisions rather than gaps:

- **ESLint / Prettier** — not yet. `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` catch the class of thing that matters here. Style consistency across
  a single-author repo is not worth a config surface today. Revisit if a second contributor appears.
- **CI workflow** — deliberately deferred until there is a git remote to run it on; until then a
  workflow file would be inert. Add it the day a remote exists, not before.
- **A test framework (vitest/jest)** — see above. Node's runner is sufficient and free.
- **A logging library** — nothing to log yet. The suite's output is its report, which is a
  designed artifact, not log lines.
- **`node:sqlite`** — available and non-experimental enough to use (verified present in v22.22.0,
  emits an ExperimentalWarning). Not needed yet; results are files. Noted because the project's
  origin framing was "the SQLite of email servers", and it may earn its place later for storing
  dated run history. It has not earned it now.
- **A src/ layout beyond what exists** — directories get created when something goes in them.

## Consequence

`npm test` and `npm run typecheck` are the whole toolchain. If either grows a step, that step
should have a reason recorded here.
