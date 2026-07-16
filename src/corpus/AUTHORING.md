# How to author a corpus module

A corpus module is a set of `TestCase`s (and their `Mutant` negative controls) that
check a group of related requirements against a live server. This is a contract, like
`src/register/EXTRACTING.md`. Read it fully before writing tests.

## The five rules that keep the suite honest

1. **Every test cites a real requirement.** `requirement` is a `RequirementId`, so an
   untraceable test does not compile. Use `alsoTouches` for secondary requirements the
   same exchange bears on, but keep `requirement` the single thing the test exists for.

2. **Assert the class the spec constrains, never a tighter thing.** RFC 5321 mostly fixes
   the reply *class* (2yz/4yz/5yz), not the exact code. A test that asserts `550` where the
   spec permits any `5yz` will fail conforming servers that answer `551` or `553`. When in
   doubt, assert `severity(reply) === 5`, not `reply.code === 550`. The register notes call
   these landmines out per requirement — read them.

3. **A declined SHOULD is not a failure.** §1.3 says every keyword use is a conformance
   requirement, but it does NOT promote SHOULD to MUST. The outcome model enforces this, but
   you must still *judge* honestly: return `violated` for "the SHOULD behaviour did not
   happen" and let the model grade it `permitted-latitude`. Never reach for `violated` only
   when you think it should be fatal.

4. **A MAY has no failure state.** If a requirement is MAY, you may only return `satisfied`,
   `observed` (with which branch was taken), or `inconclusive`. Returning `violated` for a
   MAY throws — by design. If you find yourself wanting to fail a server for a MAY, you have
   misread the requirement.

5. **Every wire-testable requirement needs a Mutant.** A test that has never been shown to
   FAIL against a broken server is faith, not evidence. Pair each `TestCase` for a `wire`
   requirement with a `Mutant` naming the mutant-server defect that must trip it. The
   coverage report marks a test without a proven mutant as `test-only`, not `covered`.

## The rule that binds US, not the server

**Never use the RFC's own example domains or addresses.** RFC 5321 prints real, resolvable
hosts (isi.edu and others). Pointing a conformance run at one is someone else's incident.
Use only RFC 2606 reserved names: `example.com`, `example.net`, `example.org`, and the
`.invalid` / `.test` TLDs. The suite's own client identity defaults to
`conformance-suite.invalid`. Fixtures the operator declares are theirs; everything the
corpus invents must be RFC 2606.

## Preconditions

If a test needs server-side state (a valid recipient, a reject domain, a quota), declare it
in `needs.fixture`. The runner yields `inconclusive` — never a false failure — when the run
lacks it. Do NOT hardcode an address and hope; a test that assumes `postmaster@` exists
without declaring the need is a test that lies on a server configured differently.

If a test needs an EHLO extension, declare it in `needs.ehlo`. A server not advertising it
is out of scope for that test (`inconclusive`), not non-conformant.

## Judging: observe, then conclude

A test body may only observe (via `Conn`) and return a `Judgement`. It cannot see the
register, decide its own `Outcome`, or reach other tests. Keep bodies small: drive the
exchange, read the replies, and return one of:

- `{ kind: 'satisfied' }` — the required behaviour was observed.
- `{ kind: 'violated', detail }` — it was not. (Graded by Level: fatal only for MUST-family.)
- `{ kind: 'observed', branch }` — a MAY branch was taken; name it.
- `{ kind: 'inconclusive', reason }` — could not tell (rare; usually the runner handles this).

Use `conn.expectQuiet(ms)` for requirements whose violation is *action where there should be
none* — a reply to an unterminated command line, honouring a bare LF. Silence is the pass.

## Evidence

You get evidence for free: the runner captures the full byte transcript and the last reply.
Make `intent` and `rationale` genuinely useful — they are what a human reads when triaging,
and calibration (task #23) assumes the suite is wrong until the transcript proves otherwise.

## Module shape

```ts
import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant } from '../conformance/test-case.ts';
import { crlf, lf } from '../wire/bytes.ts';

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'bare-lf-not-honoured-as-terminator',
    requirement: 'R-5321-2.3.8-a',
    intent: 'a command terminated by bare LF is not acted upon',
    rationale: '§2.3.8: implementations MUST NOT recognize any other sequence as a line terminator',
    run: async (conn) => { /* ... */ },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  { catches: 'bare-lf-not-honoured-as-terminator', defect: 'honourBareLf',
    why: 'a server that terminates a command on bare LF violates §2.3.8' },
];
```

Register the module in `src/corpus/index.ts` (add to `ALL_CASES` / `ALL_MUTANTS`). The
coverage report reads those, so an unregistered module is invisible — which the report will
show as uncovered requirements, not as a pass.

Wire the module's `*.test.ts` to the matching harness (all in `negative-control.ts`):
`verifyNegativeControls` for ordinary MUST cases, `verifyLatitudeControls` for SHOULD/MAY,
`verifySinkControls` for delivery-path cases. Each proves every case both ways for you.

## Three kinds of case, three harnesses

- **MUST / MUST NOT** — a `TestCase` + a `Mutant` in `MUTANTS`, proven by `verifyNegativeControls`
  (clean → not a finding; defect → non-conformant). The default.
- **SHOULD / MAY** — a `TestCase` (whose `run` returns `violated` on the decline; the outcome
  model maps that to `permitted-latitude`, never a finding) + a `LatitudeControl` in `CONTROLS`
  giving the `follows`/`declines` mutant defects, proven by `verifyLatitudeControls`. NEVER give
  a SHOULD/MAY a negative control — a declined SHOULD is not a violation, so a mutant cannot
  "catch" it, and `coverage.ts` blocks crediting it that way.
- **Delivery-path (invisible on the connection)** — dot-un-stuffing, case preservation, trace
  insertion, body fidelity. A `TestCase` with `needs: { sink: true }` whose `run` drives a
  transaction and reads `conn.sink` (a `SinkView` of the delivered message), + a `Mutant` whose
  defect corrupts the relayed message, proven by `verifySinkControls`. Inconclusive without a
  sink (a plain run against a server we can't make relay to us), never a false finding.

## alsoProves: one defect, several requirements

When two register entries state the SAME wire behaviour in different sections (e.g. NOOP
unrecognised violates both §4.5.1-b and §4.3.2-e), add an `alsoProves` array to the mutant —
each entry a `{ requirement, why }` for a requirement the caught test's exchange genuinely also
demonstrates. It is a DELIBERATE, per-claim credit, NOT automatic: an invariant test bounds each
`alsoProves` to the caught test's own `requirement`/`alsoTouches`, and `coverage.ts` refuses to
credit a non-MUST this way (SHOULD/MAY go through latitude). Never use it to paper over a gap.

## Definition of done

- `npm run typecheck` and `npm test` green.
- Every `wire` requirement you touched has a test AND a mutant, or a recorded reason it does
  not (a `deliberatelyUncovered` note on the register entry).
- You ran the module against the mutant server and saw each test go red on its defect and
  green on the clean baseline. A test only shown to pass is half a test.
