# 0005. DATA transparency / dot-stuffing is deferred, with reason

Date: 2026-07-15
Status: Accepted

## Decision

The DATA transparency corpus (RFC 5321 §4.5.2 dot-stuffing) is **deliberately deferred**, not
forgotten. This records why, so a future contributor knows it was a considered scope call.

## Why

§4.5.2's core requirement is that a receiver, on a body line beginning with a period, deletes
that leading period before delivery ("If the first character is a period and there are other
characters on the line, the first character is deleted"). **Whether the un-stuffing
happened is only observable in the DELIVERED message**, i.e. downstream of the SMTP
transaction, in the stored mail or the next hop's data stream. This receiver-side suite
connects to a server and observes its reply codes; it never sees what was delivered. So the
central transparency obligation is `not-testable` by this suite for the same reason
R-5321-2.4-c/-d (case preservation) and R-5321-4.5.2-e/-g are marked not-testable in the
register: it needs a receiving sink and an end-to-end path, which is a different tool.

The one part of §4.5.2 that IS client-observable (that a malformed or mis-timed dot sequence
must not terminate DATA early) is already covered, and covered well, by the smuggling corpus
(`crlf-discipline.ts`): the `<LF>.<LF>`, `<LF>.<CR><LF>` and `<CR>.<CR>` cases all assert that
a non-canonical dot/terminator sequence does NOT end mail data. Adding a separate dot-stuffing
module for the same observable surface would duplicate that coverage.

A contrived middle case (sending a correctly dot-stuffed `..` line and asserting the server
does not terminate at it) is technically constructible, but the mutant defect it would need
(a server that treats a stuffed `..` line as end-of-data) does not correspond to a documented
real-world bug the way the smuggling variants do. Writing a test whose only purpose is to have
a test, against a defect nobody ships, is exactly the "green for its own sake" this project
avoids.

## Revisit trigger

If the suite ever grows a **receiving sink** (the outbound-testing seam noted in
`fixture.ts` and several register notes: an SMTP server we control, to which the server under
test relays, so we can inspect the delivered bytes), then §4.5.2 un-stuffing, case
preservation (§2.4-c/-d), and the non-modification requirements (§2.4-i) all become testable
at once. That sink is the natural home for a real dot-stuffing corpus. Until then, this is a
known, reasoned gap, visible in the coverage report as `not-testable` register entries, not a
silent omission.
