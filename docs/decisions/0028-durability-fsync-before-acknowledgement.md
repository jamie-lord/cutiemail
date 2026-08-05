# 0028. Durability: fsync before every acknowledgement

## Status

Accepted (2026-07-30).

## Context

Every database here always opens in WAL mode through one function, `openMailDb`
([open-mail-db.ts](../../src/store/open-mail-db.ts)). Until now, that function also set
`PRAGMA synchronous=NORMAL`. People usually name the two settings together as the standard
high-concurrency SQLite posture, and for most applications they are the right pair. For a mail
server they are not, and the reason is a promise this project makes out loud on the wire.

When the SMTP receiver answers `250`, RFC 5321 §6.1 already changed who is responsible for the
message. The sending MTA is now entitled to forget it. A `250` is not "I have probably got this". It
is "I have got this, you may stop trying." The same is true of a `250` on the submission port (the
user's client deletes its local copy of a Sent message), and of an `OK` to an IMAP `APPEND`/`COPY`/
`MOVE`. Each is an acknowledgement that transfers custody of mail to us.

The code already honoured that. The code **sequences the acknowledgement after the commit**
everywhere it matters. The receiver writes its `250` only after it awaits the delivery handler, whose
`append()` runs synchronously through to `COMMIT`
([smtp-receiver.ts](../../src/server/smtp-receiver.ts)). Submission enqueues onto the persistent
queue and *then* acks. The dead-letter move is one insert-then-delete transaction that "can never be
removed-but-not-retained" ([sqlite-queue.ts](../../src/store/sqlite-queue.ts)). The ordering was
correct. What undercut it was `synchronous=NORMAL`.

Under `NORMAL` in WAL mode, a `COMMIT` is durable against a *process* crash, because SQLite hands
the frames to the operating system. But it does **not** fsync to stable storage until the next
checkpoint. A power cut, a kernel panic, or a hypervisor that kills the VM in the window between
commit and checkpoint discards the last committed transactions. For this server, that means a
message we already answered `250` for can vanish. The sender never retries, because we told it we
have the message. That is a *silent* loss of accepted mail, and "nothing is ever silently dropped" is
a load-bearing claim of the project, not a nicety. The article that prompted this review called
`NORMAL` "completely safe". The practitioners who corrected it in the thread were right, and the
correction matters more here than in a typical app, because the acknowledgement is a contract, not a
log line.

Two adjacent risks surfaced in the same review. This ADR settles them here, and does not leave them
implicit:

- **The storage engine is not a pinned dependency.** SQLite is whatever `node:sqlite` bundles.
  Version 3.51.3 (2026-03-13) fixes the "WAL-reset database corruption bug"
  ([sqlite.org/changes.html](https://sqlite.org/changes.html)) — a WAL/checkpoint corruption bug, in
  exactly the mode every database here runs, with more than one connection open per file. A
  deployment can run an older bundle and not know it (the version this landed against, Node 22.x,
  bundles 3.50.4).
- **WAL growth behind a long-lived reader** is the classic WAL failure mode. A review evaluated it
  and found it does not apply: the updater snapshots with `VACUUM INTO` and closes its handles
  immediately, IMAP `IDLE` waits on a notifier and holds no read transaction, and every IMAP mutation
  is a short scoped `transaction()`. There is no reader that pins WAL frames, so the default
  autocheckpoint bounds the WAL on its own.

## Decision

**1. `synchronous=FULL`, uniformly, at the single open path.** `openMailDb` now sets
`PRAGMA synchronous=FULL`, so a `COMMIT` fsyncs the WAL before it returns. Because the code already
sequences the ack after the commit, `250`/`OK` now means "on stable storage," across power loss and
not only a clean restart.

It is uniform rather than per-connection on purpose. `openMailDb` exists to be *the one hard-to-
misuse way* to open a database. ADR 0025's mode discussion already refused to thread a "which kind of
database is this" parameter through it, and a "which kind of *durability* is this" parameter would be
the same mistake. Every write path that acknowledges custody — inbound delivery, submission enqueue,
dead-letter, IMAP append — passes through this function. So a durable function covers the whole
category, without a taxonomy of connections to keep correct.

**2. The acknowledgement-ordering contract is explicit and tested.** `FULL` is worthless if a future
refactor ever answers `250` first and stores asynchronously. An integration test drives a full DATA
transaction with the delivery handler gated open. It asserts that the server *withholds* the
`250 2.0.0 message stored` until the handler commits ([smtp-receiver.integration.test.ts](../../src/server/smtp-receiver.integration.test.ts)).

**3. A SQLite version floor, checked at runtime, advisory.** `MIN_SQLITE_VERSION` (3.51.3) records
the floor. The server does **not** enforce it at open time, because a hard refusal would strand a
deployment on the only Node it can install. Instead `doctor` reads the live `sqlite_version()` and
**warns** when it is below the floor. This is the same advisory posture that `backup verify` takes
toward a stale WAL sidecar. Raise the floor only for a fix that materially threatens data at rest.

**4. No explicit WAL-size cap.** We considered `journal_size_limit` and scheduled checkpointing, and
declined both. With no long-lived reader (above), they would be unmeasured tuning against a problem
this deployment does not have.

## Consequences

- An acknowledged message survives power loss, not merely a graceful shutdown. The code already had
  the ordering for this durability. The server now actually provides it.
- The cost is one fsync per acknowledged write. Every bulk path is already a single transaction
  (`sqlite-mailbox.ts` `transaction()`), so the residual per-commit fsyncs are the low-rate
  acknowledgement points — one per inbound message, one per submission, one per interactive IMAP
  mutation. At one domain and a handful of humans this is negligible, and correctness is the product.
  The throughput figures in [PERFORMANCE.md](../PERFORMANCE.md) were measured under `NORMAL`. The
  append and accept rates are now fsync-bound and modestly lower, still an order of magnitude beyond
  any personal domain.
- `doctor` gains a `sqlite` line. On a deployment below the floor, it warns and names the upgrade. It
  never fails the run, so it cannot stop a deployment over a version it cannot yet change.
- Mutation proves the guards, per the project's discipline. A revert to `NORMAL` fails the posture
  test, an always-true version comparison fails the floor test, and an ack before the commit fails
  the ordering test.
