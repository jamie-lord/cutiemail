# 0001. Spec baseline: RFC 5321 is normative; 5321bis is a clarification source

Date: 2026-07-15
Status: Accepted

## Decision

The suite asserts conformance against **RFC 5321** (Klensin, October 2008, Standards Track,
obsoletes RFC 2821, updates RFC 1123). The project vendors a verbatim copy at `spec/rfc5321.txt`.

**draft-ietf-emailcore-rfc5321bis is NOT the baseline.** The suite uses it only as a
*clarification source* (see decision 0003 and the `bisNote` field on register entries).

## Why 5321 and not the bis

Checked on the IETF datatracker, 2026-07-15:

| Document | Status (verbatim) | RFC number |
|---|---|---|
| `draft-ietf-emailcore-rfc5321bis` (rev 44, 2025-07-31) | `RFC Ed Queue : Blocked` | none assigned |
| `draft-ietf-emailcore-rfc5322bis` | `RFC Ed Queue : Blocked` | none assigned |
| `draft-ietf-emailcore-as` (Applicability Statement) | `IESG Evaluation::AD Followup` | none assigned |

Both bis documents are approved. They sit in the RFC Editor queue in the `Blocked` state with
no number assigned. The Applicability Statement is still in IESG evaluation, and the two bises
almost certainly cluster behind it. That is the normal cause of a `Blocked` RFC-Editor state.

So the bises are finished work that has not shipped. **You cannot conform to a document that has no
RFC number.** RFC 5321 remains the standards-track text that a server must implement, so it is
what we assert against.

## Why the bis still matters (and is not just noise)

A `bis` document exists to resolve what implementers read differently. RFC 5321 is about 17 years
old. Every ambiguity that the bis clarifies is, by construction, an ambiguity that real
implementations disagreed about. **The 5321→5321bis diff is a map of likely divergence.** That map
is exactly the target a conformance corpus wants.

Handling: register entries carry an optional `bisNote` that records whether 5321bis clarifies,
tightens, or reverses the 5321 reading. Where they differ, the note also records which reading the
suite asserts and why. We assert the 5321 reading by default. A deliberate exception must appear
per-entry.

## Recheck trigger

If either bis leaves the RFC Editor queue and gets an RFC number:

1. The baseline moves to the published RFC.
2. The register needs a full revision pass, not a search-and-replace: a bis can *change* requirements,
   not merely renumber them.
3. Every entry with a `bisNote` is a candidate for re-decision.

This is a real possibility during the project's life: the documents are approved and blocked, not
stalled in a working group. **Recheck at the start of any session that touches the register.**

## Scope: what we test

**Receivers only.** RFC 5321 binds both SMTP clients (senders) and servers (receivers). This suite
connects *to* a server, so it can only observe receiver behaviour. The register keeps the
requirements that bind the client and marks them `party: client` / untestable-by-this-suite. The
honest denominator then stays visible instead of quietly disappearing.

To test client conformance, cutiemail would have to be a server and drive the client, which is a
different tool. This is explicitly out of scope, not forgotten.

## Scope: related RFCs

In scope, asserted **only when the server advertises the extension** (see decision on conditional
extension testing):

| RFC | Extension | Rationale |
|---|---|---|
| 1870 | `SIZE` | Near-universal; interacts with 5321 §4.5.3.1 limits |
| 2920 | `PIPELINING` | Command-grouping rules are a real divergence source |
| 6152 | `8BITMIME` | Interacts with the CRLF/8-bit handling we care most about |
| 3207 | `STARTTLS` | The MUST-discard-state rule is a historical bug class |
| 4954 | `AUTH` | Needed to reach authenticated paths at all |
| 6531 | `SMTPUTF8` | EAI divergence is known-poor across implementations |
| 3463 | Enhanced status codes | Needed to *parse* replies, asserted only where advertised |

Out of scope for v1, with reasons:

- **RFC 5322 (message format)**: SMTP treats mail data as essentially opaque. The transport does not
  parse the message. Only where 5321 itself imposes content requirements (for example, §4.4
  `Received:` / `Return-Path:` trace fields) do those become register entries. A 5322 corpus is a
  *different* project (a parser corpus, not a protocol corpus).
- **RFC 6409 (Message Submission)**: different port, different obligations (submission servers MAY
  repair messages that an MX MUST NOT touch). One register that mixes submission and relay semantics
  would make every result ambiguous. This is deferred deliberately. Revisit it once the MX corpus
  calibrates.
- **RFC 3461 (DSN), 3798 (MDN)**: orthogonal to transport conformance.
- **RFC 7504 (NULL MX), 5321 §5 DNS resolution**: requires controlled DNS. The suite asserts on-wire
  behaviour against a given host:port and does not drive resolution. Revisit this if precondition
  management grows a DNS fixture.
- **SPF/DKIM/DMARC/ARC**: separate corpora already exist and are vendorable (open-spf.org RFC 7208
  suite, ValiMail `arc_test_suite`). Not our job to re-derive.

## Consequences

- Every register entry cites `spec/rfc5321.txt` by section, against a pinned copy.
- Extension requirements are conditional and cannot fail a server that does not advertise them.
- The register's denominator is "RFC 5321 requirements binding a receiver", and everything else is
  visible-but-excluded rather than absent.
