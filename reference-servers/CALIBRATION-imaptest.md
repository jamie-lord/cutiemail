# Calibration against Dovecot imaptest (2026-07-17) — the IMAP server

The IMAP server is the largest hand-built surface in the project, and until now it had
only ever been driven by our own tests and adversarial audits — never by independently
written software. This is that calibration: **Dovecot's `imaptest`**, the canonical IMAP
stress/consistency tester, pointed at our `ImapServer`. It found a real RFC 9051 §7.4.1
violation on the first run.

## How it was built and run

`imaptest` has no Homebrew formula and its Docker image can't run here (the box's Docker
egress is broken — see `README.md`), and no imaptest branch compiles against Ubuntu's
patched Dovecot 2.3.21 headers. So it was built the officially-supported way: **vanilla
Dovecot 2.3.21 from source** (`dovecot.org/releases/2.3/dovecot-2.3.21.tar.gz`), with
imaptest's matching `release-2.3.21` branch linked against that source tree
(`./configure --with-dovecot=/opt/dovecot-2.3.21`).

imaptest speaks plaintext IMAP, but our production server is IMAPS-only. So it drives a
throwaway **plaintext instance of our own server** — `src/testing/imap-plaintext-launcher.ts`,
which wires the exact `ImapServer` + `SqliteCatalog` the daemon uses (INBOX + the RFC 6154
special-use folders), on a temp database, on localhost. This tests our real IMAP code over
a plain socket; only the TLS wrapper is absent.

```sh
# on the box
node /opt/mailserver/src/testing/imap-plaintext-launcher.ts 14300 /tmp/run.db test testpass &
/opt/imaptest/src/imaptest host=127.0.0.1 port=14300 user=test pass=testpass \
    mbox=/tmp/imaptest.mbox clients=5 msgs=20
```

## The finding: sequence renumbering across connections (RFC 9051 §7.4.1)

The first multi-client run produced ~28 errors, all of one class:

```
Error: test[131]: UID changed for sequence 7: 72 -> 68: * 7 FETCH (... UID 68)
Error: test[1028]: UID=0 MODSEQ dropped 2377 -> 2376: ...
```

### Triage

**Single-connection runs were completely clean** (`clients=1`: zero errors over a full
run). The errors appeared only with concurrent clients — so this was never a single-session
UID/MODSEQ bug, but a cross-connection one. A deterministic two-socket reproduction pinned it
exactly:

- Connection B `SELECT`s a 5-message INBOX (seq 1..5 → UID 1..5).
- Connection A expunges UID 2.
- B, with no intervening boundary, issues `FETCH 2 (UID)` — and got **`UID 3`**.

The server had silently renumbered B's sequence 2 onto UID 3, **without first sending B the
EXPUNGE**. RFC 9051 §7.4.1 forbids exactly this: a server must not renumber a connection's
sequence view until it has sent that connection the EXPUNGE, and it may not send EXPUNGE
during a FETCH/STORE/SEARCH. A sequence-based client would read or modify the wrong message
under concurrency — a real correctness bug. The "MODSEQ dropped" errors were downstream of
the same confusion (imaptest attributing a modseq to the wrong UID).

**This was a known, recorded limitation** (the build log and the old `syncSelected` comment
both described it as deliberately scoped, "a larger rearchitecture"). imaptest independently
confirmed it was real and observable — and the fix turned out to be bounded, not a
rearchitecture.

### The fix

The per-connection view (`knownUids`) already existed for computing EXPUNGE/EXISTS at
boundaries. The bug was that sequence resolution (`#resolveSet`) read the *live* message
list instead. A connection-local `resolveForConn` now resolves sequence numbers against
`knownUids` — the numbering the client last saw — so:

- `FETCH 2` when B's UID 2 was peer-expunged returns **nothing for seq 2** (the message is
  omitted, never replaced by another), and seq 3/4/5 stay pinned to UID 3/4/5.
- The EXPUNGE surfaces only at B's next boundary (NOOP/CHECK/IDLE), and only then does B
  renumber.
- SEARCH numbers its results against the same view. UID-addressed commands are unchanged
  (immune to renumbering) but report client-view sequence numbers.

A self-`APPEND` to the selected mailbox now also surfaces the new message immediately (an
untagged EXISTS + view update, RFC 9051 §6.3.12) so a following sequence command can address
it. Regression tests are in `src/server/imap-multiconnection.test.ts`.

### Re-run: clean

After the fix, `clients=5` for 25 s drove **~2,830 APPENDs, ~2,810 EXPUNGEs, ~12,400 total
mutations** (measured from the throwaway DB's `uid_next` / expunge log / `highest_modseq`)
with **zero errors**, and the server never crashed. The instrument that found the bug now
passes the server clean under concurrency.

## Scripted conformance mode (`test=`) — a second real bug

imaptest also ships ~70 scripted protocol tests (`src/tests/`: fetch, search, store,
copy, expunge, esearch, uidplus, list, …). Run against our server they reported "29
groups failed" — a number that needed triage, not a headline:

- **State-leak cascade (most of it).** The scripts assume a fresh account and reuse one
  work mailbox (`imaptest`) across groups; our storage is *persistent*, so a mailbox from
  an earlier group made a later `CREATE imaptest` return `NO ... already exists`, failing
  the group's setup and everything after it. Verified not a bug: `CREATE foo` → `DELETE
  foo` → `CREATE foo` all succeed, and SUBSCRIBE/LSUB/LIST (SUBSCRIBED) all work — the
  failures were leftover state, not defective commands.
- **Unsupported extensions.** imaptest reported "0 skipped due to missing capabilities" and
  ran the SORT / THREAD / CATENATE / URLAUTH / BINARY scripts anyway; we deliberately don't
  implement those (recorded cuts), so their failures are expected, not conformance gaps.
- **Genuine bug: system flags were case-sensitive.** Running the core scripted tests
  each against a *fresh* in-memory server (to strip the state-leak cascade) left a
  uniform failure across almost all of them: an `expunge` that produced no `* EXPUNGE`.
  Root cause — imaptest sends `store 2 flags \deleted` in **lower case**, and the server
  stored `\deleted` verbatim; EXPUNGE / the \Seen fetch side-effect / SEARCH all look for
  the capitalised `\Deleted` / `\Seen`, so the flag never matched and the message was
  never expunged. RFC 9051 §2.3.2 makes system flags case-insensitive. **Fixed:** STORE
  and APPEND now canonicalise system flags (`\deleted` → `\Deleted`, etc.); keywords stay
  case-sensitive. Regression test in `src/server/imap-store.integration.test.ts`.
- **One genuine bug: LIST wildcard matching.** `LIST "" *` listed everything, but *any*
  pattern with a literal prefix — `qbox*`, `INBOX/%`, `parent/%` — matched **nothing**.
  `matchNames` only handled a bare `*`/`%` and treated every other pattern as an exact
  name (a stale "flat namespace" assumption), so a client walking the hierarchy with
  `LIST "" "INBOX/%"` got an empty tree. Also every folder reported `\HasNoChildren` even
  when it had children. **Fixed:** proper IMAP wildcard→regex matching (`*` crosses the
  hierarchy separator, `%` does not, literals escaped) plus a real `\HasChildren`
  computation. Regression tests in `src/server/imap-list.integration.test.ts`.

## What this de-risks

The IMAP server's multi-connection behaviour — the phone-plus-desktop case central to the
vision — is now validated by an independent implementation, not just our own tests. imaptest
exercises command sequences and concurrency our hand-written tests didn't, and it caught a
real §7.4.1 violation the passing suite shared a blind spot with.

### Residual scripted failures — triaged

After the three fixes, the core scripted tests were re-run each against a *fresh*
in-memory server. Nine now pass outright (multiappend, store, move, esearch, uidplus,
fetch-bodystructure, search-size, nil, atoms). The rest were spot-triaged; the residual
is **not** a pile of unexamined red:

- **Deliberate IMAP4rev2 cuts.** `SEARCH NEW`/`OLD`/`RECENT` and the `\Recent` flag were
  *removed* in RFC 9051, which we advertise — so rejecting them with `BAD` is conformant.
  imaptest's scripts predate rev2 and test them; those failures are expected. (Verified
  the server BADs them and stays healthy — no crash.)
- **Unsupported extensions we never claimed:** SORT, THREAD (imaptest runs them regardless
  of advertised capabilities).
- **A minor nicety:** when a STORE introduces a new keyword, we don't re-advertise the
  mailbox's `FLAGS` list; imaptest flags that.

A fourth genuine bug fell out of this triage and **was fixed**:

- **`SEARCH SENTBEFORE`/`SENTON`/`SENTSINCE` reduced the Date header to a UTC day.** The
  `search-date` script (probing the EET +0200 → EEST +0300 boundary) showed our result set
  off by a message at the day boundary. RFC 9051 §6.4.4 compares the Date header's date
  *as written*, disregarding time and zone; we ran it through `Date.parse` (→ UTC), which
  shifts the day across midnight for a non-UTC message (a `24 Mar 01:00 +0200` message is
  the 24th to its sender but the 23rd in UTC). **Fixed** by adding the header's own numeric
  zone offset back before reducing to a day — the `search-date` script now passes 0/29.
  Regression test in `src/imap/search.test.ts`.

A fifth concrete bug from the `list` script **was fixed**:

- **A trailing hierarchy separator on CREATE was stored literally.** `CREATE foo/` made a
  mailbox actually named `foo/`. RFC 9051 §6.3.4: a trailing separator is only a
  "this name will have children" declaration, and a server that doesn't require it MUST
  ignore it. **Fixed** in `canonicalMailboxName` (the single point every command resolves
  names through), so `foo/` and `foo` are the same mailbox across CREATE/SELECT/DELETE/LIST.
  Regression test in `src/server/imap-list.integration.test.ts`.

**Deliberate scope cut (recorded).** The remainder of the `list` script asserts Dovecot's
specific hierarchy model — trailing-separator CREATEs producing `\Noselect` *intermediary*
nodes that are then excluded from `*` listings, and ancestor-only nodes appearing in `%`
results. cutie-mail models mailboxes as a flat catalog of slash-named names with correct
wildcard matching; it does **not** synthesise `\Noselect` placeholder nodes for missing
ancestors. Real modern clients (Thunderbird, Apple Mail) create ordinary mailboxes and do
not depend on this, so — per the project's opinionated-and-modern scope — it is intentionally
not implemented rather than a gap to close.

## Still open

- A larger concurrent-client / longer-duration soak.
- imaptest links vanilla Dovecot 2.3.21; Ubuntu ships a patched 2.3.21, so the build uses the
  upstream source tree rather than the distro headers (recorded in the build steps above).
