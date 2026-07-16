# smtp-conformance

A conformance test suite for **SMTP receivers**, asserting behaviour against RFC 5321 and the
STARTTLS security surface of RFC 3207.

Point it at a mail server; it drives real SMTP exchanges over a socket and reports, for each
requirement it checks, whether the server is conformant, non-conformant, exercising permitted
latitude, or whether the check was inconclusive. It exists because — remarkably — nothing else
does this. There are excellent IMAP conformance tools (Dovecot's imaptest) and JMAP ones
(Fastmail's JMAP-TestSuite), but for SMTP there is no equivalent: swaks drives, Postfix's
smtp-source loads, Mailpit and GreenMail fake, and Postfix's own tooling explicitly disclaims
compliance testing.

## Why it can be trusted

A conformance suite that reports all-green against a broken server is worse than no suite. Two
design commitments guard against that:

1. **Every check is proven to detect its violation.** Each test is verified both ways against
   a [mutant server](src/testing/mutant-server.ts) with switchable defects: conformant against
   a clean server, non-conformant against exactly the defect it targets. A test never shown to
   fail is not counted as coverage.

2. **The suite does not lie about latitude.** Most of RFC 5321 is SHOULD/MAY, not MUST. A
   [four-state outcome model](src/conformance/outcome.ts) grades each result by the
   requirement's RFC 2119 level: a declined SHOULD is *permitted-latitude*, never a failure,
   and a MAY reported as violated is a test-authoring bug that throws. Only a violated
   MUST/MUST NOT is a finding.

Everything traces to the [requirement register](src/register/) — all 570 normative statements
in RFC 5321 §§1–7, plus the STARTTLS command-injection requirement from RFC 3207 §4.2, each
quoted verbatim (enforced by a test that checks every quote against the vendored RFC — 5321 or
3207 — it claims), with its level, the party it binds, and whether it is observable from a
receiver socket at all. Of the 571, **223 are wire-testable** (some only with a receiving sink);
the rest bind the client or are
unobservable, and the register says so rather than hiding behind a flattering percentage. Every
wire-testable MUST is now either covered by a proven negative control or carries a recorded
"deliberately uncovered" decision — there are no silent gaps.

## Usage

Requires Node ≥ 22.18 (it runs the TypeScript directly — no build step).

```sh
npm install

# See the register coverage — what is tested, what is a deliberate gap, what is not testable
node src/cli.ts coverage

# List every corpus case and the requirement it checks
node src/cli.ts list

# Run the corpus against a server described by a JSON config
node src/cli.ts run --config reference-servers/postfix.json
```

A finding exits 1, a clean run exits 0, a config error exits 2 — so it drops into CI directly.

### Target config

```json
{
  "name": "my-server",
  "serverDomain": "mail.example.com",
  "host": "10.0.0.1",
  "port": 25,
  "tls": "none",
  "version": "postfix-3.8.1",
  "fixture": {
    "clientDomain": "conformance-suite.invalid",
    "validRecipient": "postmaster@example.com"
  }
}
```

The `fixture` block is how the suite is told about server-side state it cannot create over the
wire — a valid recipient, a domain the server won't relay to, a declared size limit. A check
that needs a fixture the run doesn't have yields *inconclusive*, never a false pass or fail.
This is the hard problem that makes SMTP conformance testing different from IMAP: you cannot
build the state in-band. See [fixture.ts](src/conformance/fixture.ts).

## What it currently checks

Every wire-testable MUST is covered. The corpus spans sixteen modules, each case verified both
ways against the mutant server. Highlights:

- **CRLF discipline and SMTP smuggling** — the flagship. Detects the `<LF>.<LF>`,
  `<LF>.<CR><LF>` (CVE-2023-51764/65/66) and `<CR>.<CR>` (Cisco) end-of-data variants, plus
  bare-LF terminators and unterminated commands.
- **STARTTLS command injection (RFC 3207)** — the CVE-2011-0411 "NO STARTTLS" class: a command
  pipelined in the same TCP segment as STARTTLS must be discarded, not processed. Tested on the
  plaintext channel without needing a live TLS handshake.
- **Session sequencing and command-buffer effects** — RSET/NOOP/QUIT semantics, EHLO-as-RSET
  transaction clearing, RSET-before-EHLO, out-of-order commands, per-command buffer effects.
- **Minimum implementation** — the mandatory command set, the bare-`postmaster` recipient, one
  reply per command.
- **Reply structure** — three-digit codes, the first-digit and second-digit grammar, multiline
  format, `<CRLF>` framing, the 512-octet reply-line limit.
- **Extensions** — STARTTLS advertise-vs-honour, and the honour-but-don't-advertise
  falsification (AUTH/STARTTLS/EXPN).
- **Size limits, error handling, mail transaction, connection, termination, syntax/case,
  mail delivery** — the §4.5.3.1 floors, connection survival through errors, source-route
  preparedness, greeting/EHLO identity, and the delivery path.
- **Delivery-path transparency** — the surface that is invisible from the client side and only
  observable at a *receiving sink* the server relays to: dot-un-stuffing (§4.5.2), local-part
  case preservation (§2.4-d), the prepended Received: trace line (§4.4), and control-character
  delivery (§4.5.2-e). The sink is a faithful receiver; the mutant relays to it so each defect
  is caught in the delivered message.
- **Latitude observations** — SHOULD/MAY branches (8BITMIME, VRFY/EXPN/HELP support,
  NOOP-parameter and trailing-whitespace tolerance, …) recorded for the per-server matrix but
  never scored as findings.

The wire-level attack detail behind the smuggling and STARTTLS corpus is distilled, with
sources, in [docs/research/smtp-divergence.md](docs/research/smtp-divergence.md).

## Calibration before trust

The runner is our own code. Before any result is trustworthy it must be calibrated against
known-good servers — Postfix and Exim, the most spec-scrutinised MTAs alive — with every
disagreement triaged to *our bug*, *our misreading of the RFC*, or *a genuine divergence*. See
[reference-servers/](reference-servers/). This step is not optional and is currently
outstanding.

## Design decisions

Recorded in [docs/decisions/](docs/decisions/): why RFC 5321 rather than the unpublished
5321bis, why a from-scratch TypeScript runner rather than Apache MPT, and what the deliberately
minimal toolchain leaves out.

## Development

```sh
npm test          # the whole suite, including the negative-control proofs
npm run typecheck # tsc --noEmit; strict, with noUncheckedIndexedAccess and friends
```

Zero runtime dependencies. To add a corpus module, read [src/corpus/AUTHORING.md](src/corpus/AUTHORING.md) —
it is a contract, not a style guide.
