# 0008. The outbound client harness, and the `wire-client` testability kind

## Status

Accepted (2026-07-16).

## Context

The server must *send* mail, not only receive it: a submission from Thunderbird
becomes an onward SMTP delivery from us to the recipient's MX, and in that leg **we
are the SMTP client**. RFC 5321 binds a client with real obligations: transmit
CRLF only, wait for each reply before the next command (lock-step), never send
message data after a 5yz, terminate DATA with `<CRLF>.<CRLF>`, prefer EHLO and fall
back to HELO. The register holds 141 such client-binding requirements.

Until now every one was `testability: not-testable`, with reasons of the form
"binds the client; this suite connects outward to a server and can only observe the
server." That is accurate **for the receiver conformance suite**, the suite whose
coverage report `src/report/coverage.ts` produces. It points at a third-party
server (Postfix, Exim, the mutant server) and watches what the server does. A
client obligation is invisible from that seat.

But it is *not* invisible in general. The receiver side already has a reference
implementation with switchable defects (the mutant server), driven by a runner
that asserts detection. The client side has an exact mirror available: a **reference
delivery client with switchable defects**, driven against a **scripted peer**
(`src/testing/scripted-server.ts`, which is honest about being a non-oracle test
double), with a corpus asserting the bytes the client emits and how it reacts to
the peer's replies. Under that harness the client obligations are directly
observable. Leaving them `not-testable` once the harness exists would make the
register understate what the project can verify.

## Decision

1. **Introduce a testability kind `wire-client`.** It means: *assertable by driving
   our own reference SMTP delivery client against a scripted peer and observing the
   protocol it emits.* It sits alongside `wire` (receiver, over a socket), `parse`
   (in-process library adapter) and `wire-with-fixture`.

2. **Reclassify the client send-path requirements the harness actually covers**,
   from `not-testable` to `wire-client`, each with a note naming the client-defect
   that is its negative control. The first tranche (this increment):

   | Requirement | Level | Client behaviour asserted | Negative control (defect) |
   |---|---|---|---|
   | R-5321-2.1-h    | MUST     | lock-step: wait for each reply | `pipelineWithoutWaiting` |
   | R-5321-2.3.8-c  | MUST NOT | transmit CRLF only, never bare CR/LF | `emitBareLf` |
   | R-5321-3.3-u    | MUST     | terminate DATA with `<CRLF>.<CRLF>` | `skipTerminatingDot` |
   | R-5321-3.3-y    | MUST NOT | no message data after a 5yz | `ignore5yzAndSendData` |
   | R-5321-2.2.1-c  | SHOULD   | open with EHLO, not HELO | `heloOnly` |
   | R-5321-3.2-c    | SHOULD   | fall back to HELO on EHLO refusal | `noHeloFallback` |

3. **Two clients, never conflated.** The receiver suite has its *own* probe-client
   that deliberately violates some of these (it emits bare LF to test servers for
   SMTP smuggling; it can open with HELO to exercise R-5321-2.2.1-d). That is
   correct behaviour for a *test* client and is exactly why these were
   not-testable from the receiver seat. The requirement binds "SMTP client
   implementations"; our **product's** delivery client is one, and it is that
   client the outbound suite verifies. The distinction is written into each
   reclassified note so a reader cannot mistake one client for the other.

4. **The receiver coverage report stays honest without inventing gaps.** A
   `wire-client` requirement is scored by the outbound corpus, not the receiver
   corpus, so `computeCoverage` maps it to a new `client-suite` state, neither an
   `uncovered` gap (it *is* covered, elsewhere) nor a permanent `not-testable`
   (it is testable now). The receiver report thus reports these accurately as
   "client-binding, covered by the outbound client suite."

## Consequences

- The outbound suite is a **new reference implementation plus corpus**, mirroring
  the mutant-server pattern rather than the deployed-conformance pattern. Like the
  library-adapter registers, the corpus can precede the production client.
- **Bare-minimum-first (per ADR 0007).** This increment covers the six send-path
  requirements above with a single-transaction delivery client. The remaining
  client obligations (queueing and retry scheduling §2.1-b/§4.5.4, MX/source-route
  policy, 8BITMIME negotiation, timeouts §4.5.3.2) stay `not-testable` until the
  harness grows to reach them; each reclassification a recorded decision, never a
  silent flip.
- **Deferred, recorded:** a *dedicated* outbound coverage report (the client
  analogue of `coverage.ts`, scoring `wire-client` requirements against the
  outbound corpus with its negative controls). Until it exists the outbound corpus
  proves detection the same way the receiver corpus's earliest tests did (by
  pairing every conformant assertion with a defect that must be caught), but the
  count is not yet rolled into a single project-wide percentage. Unifying the two
  reports is its own deliberate step, not something to bolt on here.
