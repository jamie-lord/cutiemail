# How to extract a section into the register

This is a contract, not a style guide. The register is the project's keystone: every
conformance claim we ever make is denominated in it. If it drifts from the RFC, everything
downstream is wrong in a way no later test can detect.

Read this fully before extracting.

## The one rule that matters

**`text` is a verbatim quote from `spec/rfc5321.txt`. Never paraphrase, never tidy, never
quote from memory.**

This is enforced: `src/register/rfc5321.test.ts` normalises the vendored RFC (strips page
furniture, rejoins hyphenated line breaks, collapses whitespace) and asserts every `text`
appears in it as a substring. A paraphrase fails the build.

The rule exists because it was broken on the first attempt. `R-5321-2.4-i` was registered as
*"if the source envelope appears to be authentic, not modify it"*. The RFC actually says
*"assuming that the envelope permits doing so, relay it without inspecting that content"*: a
requirement about not **inspecting**, not about not **modifying**. It was invented from
memory by someone who had just read the section. Re-reading to fix it also revealed two
requirements missed entirely and one truncated mid-sentence.

**Open the file. Read the actual bytes. Quote what is there.**

## Process

1. Locate your section's line range in `spec/rfc5321.txt` (`grep -n` the header).
2. Read **every line** of it, not the paragraphs that look normative. Requirements hide in
   prose.
3. For each normative statement, add an entry.
4. Run `npm test` and `npm run typecheck`. Both must pass.

## What counts as a requirement

Register an entry for:

- Every RFC 2119 keyword: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, REQUIRED, RECOMMENDED.
  Set `normativeSource: 'keyword'`.
- Every statement that defines conformance **without** a keyword. Set
  `normativeSource: 'prose'` and justify it in `note`.

  Real examples: §2.4 establishes case-insensitive verbs by calling the opposite behaviour
  *"in violation of this specification"*. §2.4's *"The receiver will take no action until this
  sequence is received"* is stated as fact but is plainly testable behaviour. §2.4's *"a
  sending SMTP system is not permitted to send envelope commands in any character set other
  than US-ASCII"* has the force of MUST NOT without the word.

  `prose` entries are where interpretation creeps in. Be conservative, and always say in
  `note` what you read and why.

**One sentence can hold several requirements.** Split them when they bind different parties
or have different testability. §2.3.8's *"MUST NOT recognize or generate any other character
or character sequence as a line terminator"* binds a receiver (`recognize`) and a sender
(`generate`); we can observe only the first.

**Do not skip a requirement because it is untestable.** Register it with
`testability: { kind: 'not-testable', reason: ... }`. Deleting client-side or unobservable
requirements would shrink the denominator and flatter our coverage, which is the exact
dishonesty the register exists to prevent.

## Fields

| Field | Rule |
|---|---|
| `id` | `R-5321-<section>-<letter>`, letters in RFC reading order (`a`, `b`, … `aa`). Must match `section`. |
| `section` | Exactly as the RFC numbers it, e.g. `4.1.1.1`. |
| `page` | The `[Page N]` marker your text falls under. Check it: text spanning a page break takes the page it *starts* on. |
| `level` | The keyword. For `prose`, the level it has in force (usually `MUST` / `MUST NOT`). |
| `party` | `server` (receiver), `client` (sender), or `both`. This suite observes servers only. |
| `normativeSource` | `keyword` or `prose`. |
| `text` | Verbatim. See above. |
| `testability` | See below. |
| `note` | Extraction judgement, traps, why a `prose` entry is normative, what a test should watch for. Optional but usually wanted. |
| `bisNote` | Leave unset; task #3 populates it. |
| `deliberatelyUncovered` | Leave unset unless you are making that decision now. Cannot be combined with `not-testable`. |

### Choosing `testability`

- `{ kind: 'wire' }`: assertable with a bare connection and no server-side setup.
- `{ kind: 'wire-with-fixture', fixture: '...' }`: needs known server state (a mailbox that
  must be accepted, a domain we do or don't relay for, a quota). Describe the state
  concretely; task #12 has to make it real.
- `{ kind: 'not-testable', reason: '...' }`: client-binding, unobservable from the client
  side, or not a behaviour at all. Reasons must be substantive (>20 chars, enforced).

Be honest and pessimistic here. Over-claiming testability produces tests that can't be
written; the honest count is the point.

**Watch for the trap where a requirement looks testable and isn't.** §2.4's *"it MUST NOT be
construed as authorization"* is a rule about how to *read* the spec: there is no wire event
corresponding to construing something. §2.4's *"MAY clear the high-order bit or reject"* is
only half-observable: rejection shows on the wire, clearing shows only in the delivered
message.

## Quoting mechanics

- Concatenate with `+` across source lines; the test collapses whitespace, so line breaks in
  your quote don't matter, but the **words must match exactly**, including `[22]`-style
  reference markers, `(see the next paragraph)` parentheticals, and trailing punctuation.
- The RFC's own oddities are preserved: `MUST BE` (two words, capitalised) in §2.4 is real.
- Hyphenated line breaks (`high-` / `order`) are rejoined by the test's normaliser; quote
  the natural `high-order`.
- If a short quote risks matching elsewhere in the document, extend it with a neighbouring
  word for uniqueness and say so in `note` (see `R-5321-2.4-q`, quoted as `encoding; servers
  MAY reject such messages.`).

## Module shape

```ts
/**
 * RFC 5321 §X.Y — <Title>
 * ...
 */
import type { RequirementDef } from '../types.ts';

export const SX_Y = [
  { id: 'R-5321-X.Y-a', section: 'X.Y', page: NN, level: 'MUST', party: 'server',
    normativeSource: 'keyword', text: '...', testability: { kind: 'wire' } },
] as const satisfies readonly RequirementDef[];
```

File name: `sections/sX-Y.ts` (dots become hyphens). Export name: `SX_Y`.

Then wire it into `rfc5321.ts`: add the import, spread it into `REQUIREMENTS` **in RFC order**,
and add the section to `EXTRACTED_SECTIONS`.

## Definition of done

- `npm test` green, especially the verbatim invariant.
- `npm run typecheck` green.
- Section added to `EXTRACTED_SECTIONS`.
- You have read every line of your section and can say so honestly. If you skimmed, say that
  instead: an unextracted section is a known gap; a section falsely claimed extracted is a
  lie in the denominator.
