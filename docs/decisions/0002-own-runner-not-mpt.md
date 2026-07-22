# 0002. Write our own runner in TypeScript; do not adopt Apache James MPT

Date: 2026-07-15
Status: Accepted, supersedes an earlier recommendation to adopt MPT

## Context

Research into existing conformance harnesses (July 2026) found Apache James' **MPT** (Mail Protocol
Tester) to be the only server-agnostic scripted protocol harness in the email space:

- Apache-2.0, latest 3.9.0 released 2025-09-25, 23 versions on Maven Central, and maintained.
- `mpt/app` takes `--host` / `--port` and constructs an `ExternalHostSystem` that opens a plain
  socket to an arbitrary address, with no James-specific handshake.
- `--shabang` exists to mask a server-specific greeting, so a foreign banner does not fail every test.
- Framed protocol-generically: "a framework for the scriptable functional testing of ASCII based
  line protocols".

It was initially recommended for day-one adoption.

## Decision

**Write our own runner in TypeScript. Do not adopt MPT.**

## Why the earlier recommendation was withdrawn

1. **Language.** MPT is Java. This project is TypeScript throughout, including the eventual server.
   Adopting MPT means a JVM in the toolchain for the life of the project.
2. **It ships no SMTP corpus.** MPT's value is runner mechanics: script replay and reply
   comparison. Its actual protocol scripts live in `mpt/impl/imap-mailbox`, are IMAP-only, and are
   wired to JUnit and James host systems. The thing we would most want to inherit does not exist.
3. **The mechanics are the easy part.** A script runner over a socket is not much code.
   The hard parts of this project (the requirement register, the four-state assertion taxonomy,
   precondition management, byte-exact malformed input) are all things MPT does not solve.
4. **Byte fidelity.** Our central design rule is bytes-never-strings (see decision 0004). MPT is
   built around ASCII line protocols and a text script format. Expressing "bare LF here, not CRLF"
   is exactly what our corpus must do and exactly what a line-oriented text format fights.

Point 4 is the one that would have bitten regardless of language.

## What we give up, stated honestly

- Runner maintenance we could have inherited from an Apache project with a 20-year history.
- An independently-developed implementation, which would have given some protection against our own
  misreadings being baked into both the tests and the tool that runs them.
- Battle-tested handling of socket edge cases we will now meet ourselves.

## Mitigations

- **MPT stays a design reference.** Its script/expectation format and `ExternalHostSystem` model are
  prior art worth reading before inventing our own (see decision 0004).
- **Its portability model is the thing to copy**: connect to host:port, no spawning or managing the
  server under test, configurable expected greeting. That is precisely what makes MPT usable against
  non-James servers and what makes Cassandane unusable against non-Cyrus ones.
- **Possible later cross-check.** If our results and MPT's ever disagree on a shared script, that
  disagreement is informative. Not planned; noted as available.

## Consequences

- The runner, its script/expectation format, and its calibration are now work this project owns
  rather than inherits.
- We own the runner's bugs. Calibration against Postfix/Exim is therefore not optional polish. It
  is the only thing standing between us and confidently reporting our own defects as other people's
  non-conformance.
