# 0004 — RFC 5321bis deltas that matter for the corpus

Date: 2026-07-15
Status: Accepted (informational; revisit when 5321bis publishes)

Decision 0001 fixes RFC 5321 as the normative baseline and keeps 5321bis as a *clarification
source*. This note records the specific 5321→5321bis deltas that bear on what the suite tests,
so a corpus author knows where the two disagree and which reading we assert. It is NOT a full
per-requirement annotation of all 570 register entries — that is deferred until the bis
publishes and the diff stabilises. It captures the load-bearing cases.

Source: the SMTP-divergence research (docs/research/smtp-divergence.md), checked against
draft-ietf-emailcore-rfc5321bis-44 (31 Jul 2025).

## The one that matters most: line endings and smuggling

**5321bis does NOT close SMTP smuggling at the spec level.** Verified:

- The bis reaffirms §2.3.8 — CRLF is the only terminator, and implementations MUST NOT
  recognise any other sequence. This is unchanged in force from 5321.
- BUT receiver-side *rejection* of a bare CR or bare LF remains **discretionary (MAY)**, not
  mandatory. The bis constrains what a terminator *is*; it does not compel a receiver to reject
  malformed ones.
- §7 (Security Considerations) of draft-44 does not mention SMTP smuggling or line-ending
  interpretation divergence between MTAs.

**Consequence for the corpus:** our smuggling tests (crlf-discipline.ts) assert against the
5321 MUST NOT in §2.3.8 / §4.1.1.4-i/j — which both 5321 and 5321bis keep — NOT against any
stronger bis language, because there isn't any. A server that honours `<LF>.<CR><LF>` violates
the same clause under either document. So the corpus is stable across the bis transition here.
This is recorded so nobody later "upgrades" the smuggling tests to cite a bis strictness that
does not exist.

A verification pass REFUTED (0-3) a stronger claim that the bis "requires clients to transmit
CR/LF only as CRLF but stops short of receiver strictness" — the framing was wrong. Do not
repeat it. The accurate statement is the three bullets above.

## Reference-number churn (cosmetic, but note it)

5321 cites several now-obsoleted RFCs by their old numbers, quoted verbatim in the register:

- **RFC 1652 → RFC 6152** (8BITMIME). Register entry R-5321-2.4-n quotes "RFC 1652" as printed;
  the extension corpus tests against 6152.
- **RFC 4409 → RFC 6409** (Message Submission). Register §1.2 entries quote 4409.

5321bis updates these citations. The register keeps the 5321 text verbatim (the verbatim gate
requires it) and the notes flag the current RFC. No behavioural change; a bookkeeping delta only.

## What is deferred

A full pass annotating each register entry's `bisNote` field waits on publication, because:

1. A bis can *change* a requirement's force, not merely renumber it — that needs the final text,
   not a draft that is still in the RFC Editor queue.
2. Draft-44 is `RFC Ed Queue : Blocked` (decision 0001) — it can still change before it ships.

**Recheck trigger:** when 5321bis (and 5322bis) leave the queue and get RFC numbers, do the full
`bisNote` pass and re-evaluate every register entry, per decision 0001's recheck rule. Until
then, the corpus asserts 5321, and the deltas above are the only ones known to matter.
