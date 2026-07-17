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

## What this de-risks

The IMAP server's multi-connection behaviour — the phone-plus-desktop case central to the
vision — is now validated by an independent implementation, not just our own tests. imaptest
exercises command sequences and concurrency our hand-written tests didn't, and it caught a
real §7.4.1 violation the passing suite shared a blind spot with.

## Still open

- Single-run scripted conformance (`imaptest test=<dir>`) beyond the stress profile.
- A larger concurrent-client / longer-duration soak.
- imaptest links vanilla Dovecot 2.3.21; Ubuntu ships a patched 2.3.21, so the build uses the
  upstream source tree rather than the distro headers (recorded in the build steps above).
