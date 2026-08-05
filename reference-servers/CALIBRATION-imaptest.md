# Calibration against Dovecot imaptest: the IMAP server

The IMAP server is the largest hand-built surface in the project. Until now, only the project's own
tests and adversarial review drove it, never independently written software. This calibration
changes that. It points **Dovecot's `imaptest`**, the canonical IMAP stress and consistency tester,
at the `ImapServer`. It found a real RFC 9051 §7.4.1 violation on the first run.

## How it was built and run

`imaptest` has no Homebrew formula, and no imaptest branch compiles against Ubuntu's patched
Dovecot 2.3.21 headers. So it was built the officially-supported way: **vanilla
Dovecot 2.3.21 from source** (`dovecot.org/releases/2.3/dovecot-2.3.21.tar.gz`). imaptest's
matching `release-2.3.21` branch links against that source tree
(`./configure --with-dovecot=/opt/dovecot-2.3.21`).

imaptest speaks plaintext IMAP, but our production server is IMAPS-only. So it drives a
throwaway **plaintext instance of our own server**, `src/testing/imap-plaintext-launcher.ts`.
This launcher wires the exact `ImapServer` and `SqliteCatalog` that the daemon uses (INBOX plus the
RFC 6154 special-use folders), on a temp database, on localhost. This tests our real IMAP code over
a plain socket. Only the TLS wrapper is absent.

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
run). The errors appeared only with concurrent clients. So this was never a single-session
UID/MODSEQ bug. It was a cross-connection bug. A deterministic two-socket reproduction pinned it
exactly:

- Connection B `SELECT`s a 5-message INBOX (seq 1..5 → UID 1..5).
- Connection A expunges UID 2.
- B, with no intervening boundary, issues `FETCH 2 (UID)`, and gets **`UID 3`**.

The server silently renumbered B's sequence 2 onto UID 3, **without first sending B the
EXPUNGE**. RFC 9051 §7.4.1 forbids exactly this. A server must not renumber a connection's
sequence view until it sends that connection the EXPUNGE. It may not send EXPUNGE
during a FETCH, STORE, or SEARCH. A sequence-based client would then read or modify the wrong
message under concurrency, a real correctness bug. The "MODSEQ dropped" errors came from
the same confusion (imaptest attributed a modseq to the wrong UID).

**This was a known, recorded limitation.** The build log and the old `syncSelected` comment
both described it as deliberately scoped, "a larger rearchitecture". imaptest independently
confirmed that it was real and observable. The fix proved to be bounded, not a rearchitecture.

### The fix

The per-connection view (`knownUids`) already existed, to compute EXPUNGE/EXISTS at
boundaries. But sequence resolution (`#resolveSet`) read the *live* message list instead. A
connection-local `resolveForConn` now resolves sequence numbers against `knownUids` (the numbering
the client last saw), so:

- `FETCH 2` when B's UID 2 was peer-expunged returns **nothing for seq 2** (the message is
  omitted, never replaced by another), and seq 3/4/5 stay pinned to UID 3/4/5.
- The EXPUNGE surfaces only at B's next boundary (NOOP/CHECK/IDLE), and only then does B
  renumber.
- SEARCH numbers its results against the same view. UID-addressed commands are unchanged
  (immune to renumbering) but report client-view sequence numbers.

A self-`APPEND` to the selected mailbox now also surfaces the new message immediately (an
untagged EXISTS + view update, RFC 9051 §6.3.12) so a later sequence command can address
it. Regression tests are in `src/server/imap-multiconnection.test.ts`.

### Re-run: clean

After the fix, `clients=5` for 25 s drove **~2,830 APPENDs, ~2,810 EXPUNGEs, and ~12,400 total
mutations** (measured from the throwaway DB's `uid_next`, expunge log, and `highest_modseq`)
with **zero errors**. The server never crashed. The instrument that found the bug now
passes the server clean under concurrency.

## Scripted conformance mode (`test=`): a second real bug

imaptest also ships ~70 scripted protocol tests (`src/tests/`: fetch, search, store,
copy, expunge, esearch, uidplus, list, …). Against our server they reported "29
groups failed". This number needed triage, not a headline:

- **State-leak cascade (most of it).** The scripts assume a fresh account and reuse one
  work mailbox (`imaptest`) across groups. But our storage is *persistent*. So a mailbox from
  an earlier group made a later `CREATE imaptest` return `NO ... already exists`, which failed
  the group's setup and everything after it. This was verified not a bug: `CREATE foo` → `DELETE
  foo` → `CREATE foo` all succeed, and SUBSCRIBE/LSUB/LIST (SUBSCRIBED) all work. The
  failures were leftover state, not defective commands.
- **Unsupported extensions.** imaptest reported "0 skipped due to missing capabilities" and
  ran the SORT / THREAD / CATENATE / URLAUTH / BINARY scripts anyway. We deliberately do not
  implement those (recorded cuts), so their failures are expected, not conformance gaps.
- **Genuine bug: system flags were case-sensitive.** The core scripted tests ran
  each against a *fresh* in-memory server, to strip the state-leak cascade. This left a
  uniform failure across almost all of them: an `expunge` that produced no `* EXPUNGE`.
  The root cause: imaptest sends `store 2 flags \deleted` in **lower case**, and the server
  stored `\deleted` verbatim. EXPUNGE, the \Seen fetch side-effect, and SEARCH all look
  for the capitalised `\Deleted` / `\Seen`. So the flag never matched, and the message was
  never expunged. RFC 9051 §2.3.2 makes system flags case-insensitive. **Fixed:** STORE
  and APPEND now canonicalise system flags (`\deleted` → `\Deleted`, and so on). Keywords stay
  case-sensitive. Regression test in `src/server/imap-store.integration.test.ts`.
- **One genuine bug: LIST wildcard matching.** `LIST "" *` listed everything, but *any*
  pattern with a literal prefix (`qbox*`, `INBOX/%`, `parent/%`) matched **nothing**.
  `matchNames` only handled a bare `*`/`%` and treated every other pattern as an exact
  name (a stale "flat namespace" assumption). So a client that walked the hierarchy with
  `LIST "" "INBOX/%"` got an empty tree. Every folder also reported `\HasNoChildren` even
  when it had children. **Fixed:** proper IMAP wildcard-to-regex matching (`*` crosses the
  hierarchy separator, `%` does not, literals escaped) plus a real `\HasChildren`
  computation. Regression tests in `src/server/imap-list.integration.test.ts`.

## What this de-risks

An independent implementation now validates the IMAP server's multi-connection behaviour (the
phone-plus-desktop case central to the vision), not just our own tests. imaptest exercises command
sequences and concurrency that our hand-written tests did not. It caught a real §7.4.1 violation
that the passing suite shared a blind spot with.

### Residual scripted failures: triaged

After the three fixes, the core scripted tests ran again, each against a *fresh*
in-memory server. Nine now pass outright (multiappend, store, move, esearch, uidplus,
fetch-bodystructure, search-size, nil, atoms). The rest got spot-triage. The residual
is **not** a pile of unexamined red:

- **Deliberate IMAP4rev2 cuts.** RFC 9051 *removed* `SEARCH NEW`/`OLD`/`RECENT` and the
  `\Recent` flag, and we advertise rev2. So a `BAD` rejection of them is conformant.
  imaptest's scripts predate rev2 and test them, so those failures are expected. (This was
  verified: the server BADs them and stays healthy, with no crash.)
- **Unsupported extensions we never claimed:** SORT, THREAD (imaptest runs them regardless
  of advertised capabilities).
- **A minor nicety:** when a STORE introduces a new keyword, we do not re-advertise the
  mailbox's `FLAGS` list. imaptest flags that.

A fourth genuine bug came from this triage and **was fixed**:

- **`SEARCH SENTBEFORE`/`SENTON`/`SENTSINCE` reduced the Date header to a UTC day.** The
  `search-date` script probes the EET +0200 → EEST +0300 boundary. It showed our result set
  off by a message at the day boundary. RFC 9051 §6.4.4 compares the Date header's date
  *as written* and disregards time and zone. But we ran it through `Date.parse` (→ UTC), which
  shifts the day across midnight for a non-UTC message. (A `24 Mar 01:00 +0200` message is
  the 24th to its sender but the 23rd in UTC.) **Fixed:** the code now adds the header's own
  numeric zone offset back before it reduces the value to a day. The `search-date` script now
  passes 0/29. Regression test in `src/imap/search.test.ts`.

A fifth concrete bug from the `list` script **was fixed**:

- **A trailing hierarchy separator on CREATE was stored literally.** `CREATE foo/` made a
  mailbox literally named `foo/`. RFC 9051 §6.3.4: a trailing separator is only a
  "this name will have children" declaration, and a server that does not require it MUST
  ignore it. **Fixed** in `canonicalMailboxName` (the single point every command resolves
  names through), so `foo/` and `foo` are the same mailbox across CREATE/SELECT/DELETE/LIST.
  Regression test in `src/server/imap-list.integration.test.ts`.

**Deliberate scope cut (recorded).** The remainder of the `list` script asserts Dovecot's
specific hierarchy model: trailing-separator CREATEs that produce `\Noselect` *intermediary*
nodes, which are then excluded from `*` listings, and ancestor-only nodes that appear in `%`
results. cutiemail models mailboxes as a flat catalog of slash-named names with correct
wildcard matching. It does **not** synthesise `\Noselect` placeholder nodes for missing
ancestors. Real modern clients (Thunderbird, Apple Mail) create ordinary mailboxes and do
not depend on this. So (per the project's opinionated-and-modern scope) it is intentionally
not implemented rather than a gap to close.

## Still open

- A larger concurrent-client / longer-duration soak.
- imaptest links vanilla Dovecot 2.3.21. Ubuntu ships a patched 2.3.21, so the build uses the
  upstream source tree rather than the distro headers (recorded in the build steps above).
