# Architecture — how this is built

Read this once and the tree stops looking like 150 files. It's really two
programs that share one spine:

- **A mail server** you can `npm start` — SMTP in, IMAP out, SQLite in the middle.
- **A whole-server conformance test bed** — a fixed register of what the RFCs
  require, a corpus of cases that check it, and a mutant harness that proves each
  case actually detects its violation.

The join is the thing worth understanding first: **the same code is both.** The
reference implementations under `message/`, `crypto/`, `imap/`, `store/`,
`server/` are what runs when you start the daemon *and* the system-under-test the
corpus drives. There is no separate "test double" of the parser to drift from the
real one — the corpus tests the code that ships. That is the whole design, and
everything below is a consequence of it.

```mermaid
flowchart TB
    ref["Reference implementations<br/>message/ · crypto/ · auth/ · imap/ · store/ · server/"]
    ref --> daemon["main.ts<br/>the running daemon"]
    ref --> sut["the system-under-test<br/>the corpus drives"]

    register["register/<br/>verbatim RFC requirements"] --> corpus["corpus/ · conformance/<br/>cases + verdicts"]
    mutant["testing/mutant-server<br/>switchable defects"] --> corpus
    sut --> corpus

    daemon -.->|"same code, two roles"| sut
```

## Follow one message

The fastest way to see the server is to trace a delivery, byte for byte. This is
exactly what `src/server/daemon.integration.test.ts` does end to end.

```mermaid
flowchart LR
    A["another server<br/>client/deliver.ts"] -->|SMTP| B["SmtpReceiver<br/>server/smtp-receiver.ts"]
    B -->|append bytes| C[("SqliteMailbox<br/>store/sqlite-mailbox.ts")]
    C -->|read BLOB| D["ImapServer<br/>server/imap-server.ts"]
    D -->|IMAPS| E["Thunderbird"]
```

1. A sending MTA (in tests, our own `src/client/deliver.ts`) opens a socket and
   runs the transaction: `EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`, the terminating
   `<CRLF>.<CRLF>`, `QUIT`.
2. `src/server/smtp-receiver.ts` reads it off the wire as raw `Buffer`s, un-stuffs
   the leading dots (RFC 5321 §4.5.2), and hands the delivered bytes to a
   `store` callback.
3. `src/main.ts` wired that callback to `SqliteMailbox.append()`, so the message
   lands in SQLite as a `BLOB` — byte-exact, no round-trip through a JS string.
4. Thunderbird connects to `src/server/imap-server.ts` over TLS, `LOGIN`s (verified
   against `src/store/accounts.ts`), `SELECT INBOX`, `FETCH 1 BODY[]`. The server
   reads the `BLOB` back out and writes it down the socket inside an IMAP literal —
   the same bytes that arrived.

Nothing in that path parses a message into an object and re-serialises it. The
envelope is parsed; the content is moved as octets. That is the "bytes, never
strings" rule (`src/wire/bytes.ts` explains why the wire DSL has no default line
terminator), and it is what lets the round-trip be byte-exact instead of
approximately-exact.

## What the receiver does before it stores

The trace above is the happy path; a message off the open internet is not
trusted. Between "read the bytes" and "append to SQLite", `main.ts`'s inbound
handler authenticates the sender and records the result — informational, never a
rejection (we are a mail server, not a spam filter; that stays a recorded cut).
Because a DKIM key and the SPF/DMARC records are DNS lookups, the delivery handler
is `async`, and `smtp-receiver.ts` serialises chunk processing through a promise
chain so a pipelined sender can't re-enter it and corrupt the receive buffer.

```mermaid
flowchart TB
    raw["received bytes"] --> dkim["verifyDkim<br/>server/dkim-inbound.ts"]
    raw --> spf["checkSpf<br/>auth/spf-check.ts"]
    raw --> dmarc["checkDmarc<br/>server/dmarc-inbound.ts"]
    dns[("DNS<br/>TXT · A · MX")] --> dkim & spf & dmarc
    dkim -->|"pass domains"| dmarc
    spf -->|"result + mailfrom"| dmarc
    dkim & spf & dmarc --> ar["Authentication-Results:<br/>dkim=… spf=… dmarc=… (p=…)"]
    raw -->|"strip a forged AR<br/>bearing our authserv-id"| clean["cleaned message"]
    ar --> stamp["prepend AR + Received"]
    clean --> stamp
    stamp --> store[("SqliteMailbox")]
```

- **DKIM** (`dkim-inbound.ts`) verifies *every* signature (a message may carry
  several) over RSA or Ed25519, requiring `From` in `h=` (§5.4) and honouring
  expiry — it returns the set of passing `d=` domains so DMARC can align against
  any. It composes the vector-pinned `crypto/dkim-*` primitives; DNS key retrieval
  is the only new part.
- **SPF** (`auth/spf-check.ts`) is an async recursive evaluator over the sending
  domain's policy — `a`/`mx`/`include`/`redirect` resolved live, IPv4/IPv6 CIDR
  matched against the peer, and the RFC 7208 ten-lookup limit enforced so a hostile
  record can't fan the resolver into a DoS.
- **DMARC** (`dmarc-inbound.ts`) ties the two to the `From` domain: it passes only
  when an *aligned* DKIM or SPF identifier passed (relaxed = same organizational
  domain, via a public-suffix heuristic; strict = exact).

The composition glue is fuzzed (`server/auth-fuzz.test.ts`): 1500 malformed
records and headers, all returning a verdict without throwing. Both this and the
outbound signer are the same "compose the tested crypto, don't reinvent it" move.

## The running server, bottom up

Each layer depends only on the ones above it in this list. You can read them in
this order and never look forward.

```mermaid
flowchart TB
    main["main.ts — the daemon"] --> net["server/ + client/ — live net/tls sockets"]
    net --> store["store/ — SQLite persistence"]
    net --> proto["protocol reference impls<br/>message/ · crypto/ · auth/ · imap/ · smtp/ · transport/"]
    store --> proto
    store --> wire["wire/ — octet primitives"]
    proto --> wire
```

*(arrows are "depends on" — the daemon at the top, octets at the foundation.)*

**`wire/`** — octet primitives. `bytes.ts` builds exact wire input (`crlf`, `lf`,
`bare` are different functions on purpose, so a bare-LF smuggling probe reads as
deliberate at the call site). `reply.ts`, `transport.ts` are the reply grammar and
the socket abstraction. Everything else sends and receives through here.

**The protocol reference implementations** — hand-built parsers and engines, no
mail libraries, each with switchable defects for negative control:

- `message/` — RFC 5322 + MIME (2045/2046/2047) parsing, address grammar, DSN
  bodies (3464). The confusion surfaces — header injection, boundary splitting,
  encoded-word decoding — live here.
- `crypto/` — DKIM sign and verify end to end (canonicalisation → tag list → body
  hash → RSA/Ed25519), pinned to the RFC 6376 / 8463 test vectors. Real
  `node:crypto`, no crypto library.
- `auth/` — SPF, DMARC, ARC structure, and SCRAM (the password-never-sent proof).
- `imap/` — the IMAP4rev2 pieces: command and response grammars, literals,
  `ENVELOPE`, sequence sets, `SEARCH`.
- `smtp/`, `transport/` — the AUTH/SIZE decision logic and MTA-STS / SMTPUTF8.

**`store/`** — persistence. `mailbox.ts` is the *reference* mailbox: an in-memory
model that pins every IMAP storage invariant (UID monotonicity, no UID reuse,
flags, `EXPUNGE`, sequence numbers, `UIDVALIDITY`). `sqlite-mailbox.ts` is the
*real* one on `node:sqlite`, and it also carries `SqliteCatalog` — the set of
named folders (INBOX, Trash, Sent, …) a real client creates; `memory-catalog.ts`
is its reference twin. They expose one surface, and the corpus drives both through
a single invariant harness — so the persistent implementation is proven to
reproduce the reference behaviour exactly. `accounts.ts` (SCRAM credentials),
`queue.ts` (the retry decision) and `sqlite-queue.ts` (the persisted outbound
queue) sit alongside.

**`server/` + `client/`** — the live network layer. `smtp-receiver.ts` and
`imap-server.ts` are real `net`/`tls` servers; `client/deliver.ts` is the sending
half and `client/mx.ts` resolves MX hosts. The send pipeline is a chain of small,
separately-tested transforms — `submission-fixup.ts` (add a missing From from the
envelope sender, plus Date/Message-ID), `received.ts` (stamp the trace hop),
`dkim-signer.ts` (sign), then `sqlite-queue.ts` + `relay-loop.ts` (persist and
retry) and `outbound.ts` (resolve MX, deliver with opportunistic STARTTLS and a
plaintext fallback). When the relay finally gives up, `bounce.ts` assembles a
`multipart/report` non-delivery report and delivers it back to the sender (never to
a null return-path, so bounces can't loop). `imap-server.ts` also serves the full
read side a real client needs — `BODYSTRUCTURE` and per-part `BODY[n]` fetch (so a
client renders an attachment without downloading the whole message), the fetch
macros, `INTERNALDATE`, extended `SEARCH`/`ESEARCH`, and `DELETE`/`RENAME`.
`mailbox-notifier.ts` is the pub/sub that lets one connection's change reach another:
an inbound delivery, or an APPEND/EXPUNGE/MOVE on any connection, wakes every other
connection selected on that mailbox. Each connection keeps its own view of the
mailbox (the UIDs it has been told about) and reconciles it — emitting untagged
`EXPUNGE` for what vanished and `EXISTS` for what arrived — only at a safe command
boundary (`NOOP`/`CHECK`, or in real time while idling), never mid-`FETCH`, per
RFC 9051 §7.4.1. That is what keeps a phone and a desktop on the same mailbox in
agreement. Each module is thin and owns one concern.

**`main.ts`** — the daemon. Opens the database, seeds accounts, and starts three
listeners (inbound SMTP, submission-with-AUTH, IMAPS). Inbound mail is authenticated
(the section above), trace-stamped, and stored — and only for recipients we host, so
we never accept mail we can't deliver. Submitted mail is split by `routeRecipients` —
local recipients into a folder, remote ones through the send pipeline above.
`startServer()` is factored out from `main()` so the whole assembly is itself under
test. If you want to know what "the server" *is*, it is this file and the modules it
wires.

## The test bed, and why it can be trusted

A conformance suite that reports all-green against a broken server is worse than
none. Four moving parts stop that from happening.

```mermaid
flowchart LR
    register["register/<br/>verbatim RFC requirements<br/>(the denominator)"] --> corpus["corpus/<br/>cases citing requirement IDs"]
    corpus --> runner["conformance/<br/>runner + central outcome"]
    mutant["testing/mutant-server<br/>one defect at a time"] -->|must be caught by| corpus
    runner --> report["report/<br/>self-audit: no silent gaps"]
    spec[("spec/*.txt<br/>vendored RFCs")] -->|gate.ts verifies<br/>every quote| register
```

**`register/` — the denominator.** Every normative statement, quoted *verbatim*
from a vendored RFC, with its RFC 2119 level, the party it binds (server / client /
both), and an honest `testability` tag. `register/types.ts` defines the shape;
`register/gate.ts` is a test that checks every quote against the `spec/*.txt` file
it claims to come from — so a paraphrased or fabricated quote fails the build. This
is the fixed thing everything else is measured against: 663 requirements across six
domains from 18 RFCs (`npm run registry` prints the live count). Registrations you
*can't* test (client-binding, out-of-band) stay in the register anyway — deleting
them would shrink the denominator and flatter the coverage number.

**`corpus/` — the cases.** A `TestCase` (`conformance/test-case.ts`) is *data*, not
an assertion function: "to check requirement R, drive this exchange, then judge
what came back." `requirement` is a typed `RequirementId`, so a case citing a
requirement that doesn't exist **fails to compile** — traceability is structural,
not a convention someone has to maintain. A case may only *observe* and *conclude*;
it cannot decide its own outcome.

**`conformance/` — the runner.** `outcome.ts` computes the verdict centrally from
the case's judgement plus the requirement's level, which is why a declined `SHOULD`
comes out as *permitted-latitude* and never a failure — a test author physically
cannot grade a `SHOULD` as a finding. `fixture.ts` handles state SMTP can't
establish in-band (a valid recipient, a size limit); a case needing a fixture the
run lacks yields *inconclusive*, never a false pass. `sink.ts` is the receiving
server used to observe what the system relayed downstream (dot-un-stuffing, the
`Received:` line — things invisible on the sending connection).

**`testing/` — the negative controls.** `mutant-server.ts` is the most important
file in the repo: a receiver whose conformance breaks one defect at a time. For
every planted defect, the corpus case for that requirement must report
*non-conformant* against exactly it — and clean against everything else. A
wire-testable requirement with a case but no mutant is only *half*-covered: proven
to pass clean servers, not to catch dirty ones. The library-adapter areas
(parsers, crypto) do the same trick in-process — the reference implementation
carries defect flags, and each case runs it both clean and broken.

**`report/` — the self-audit.** `npm run library-coverage` fails the build on any
parse-testable requirement with no citing test and no recorded
`deliberatelyUncovered` decision. `npm run registry` is the cross-domain inventory.
These exist so "we covered everything" is a checkable claim, not a hope. Every gap
is either a test or a dated decision — there is no silent third category.

## The conventions that are load-bearing

These aren't style preferences; break one and something real breaks.

- **Bytes, never strings.** Mail content is `Buffer` from socket to SQLite `BLOB`
  and back. Strings are UTF-16 and SMTP is octets; the one place a string touches
  the wire it is `latin1`-encoded so the mapping is exact (`wire/bytes.ts`).
- **Zero runtime dependencies.** SQLite is `node:sqlite`, crypto is `node:crypto`,
  TLS is `node:tls`. The `package.json` `dependencies` block is empty and is meant
  to stay that way. This is the "SQLite of email" claim taken literally.
- **`erasableSyntaxOnly` TypeScript, run directly.** Node ≥ 22.18 executes the
  `.ts` with no build step, which forbids anything that needs a runtime transform:
  no `enum`, no constructor parameter properties. Classes use explicit `#private`
  fields. `noUncheckedIndexedAccess` is on, so indexing is guarded then `!`-asserted.
- **Opinionated cuts are recorded, never silent.** No POP3, IMAP4rev2 only,
  MTA-STS not DANE, SCRAM + PLAIN-over-TLS only. Each cut is an ADR in
  `docs/decisions/` with a reason, so a future reader can tell "we decided against
  this" from "we forgot."

## Where to start reading

- **To understand the server:** `src/main.ts`, then `smtp-receiver.ts`,
  `sqlite-mailbox.ts`, `imap-server.ts` — the four files the daemon composes.
- **To understand the test discipline:** `register/types.ts` and
  `conformance/test-case.ts` (both have long, load-bearing header comments), then
  `testing/mutant-server.ts`.
- **To understand the philosophy:** `docs/TESTING-ROADMAP.md` is the map of every
  pillar and its status; `docs/IMPLEMENTING-A-CONFORMANT-SERVER.md` is the hard-won
  guidance on the requirements that are easy to get wrong.

## Adding an RFC

The shape is designed so a new spec is a small, uniform change:

1. Vendor the spec text as `spec/rfcNNNN.txt` and add `'rfcNNNN'` to `SpecSource`
   in `register/types.ts`.
2. Add a register section under the relevant `register/<domain>/sections/` — the
   verbatim quotes, gated automatically against the file you just vendored.
3. Build (or extend) the reference implementation with defect flags.
4. Write corpus cases citing the new requirement IDs, each with its negative
   control.

`npm run library-coverage` will refuse to go green until every testable new
requirement is either covered or carries a dated decision not to. The register
won't let you quote text that isn't in the spec file. The type system won't let a
case cite a requirement that doesn't exist. The guardrails are the point — they're
what make "we know exactly what works" a fact about the build rather than a
sentence in a README.
