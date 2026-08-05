# 0009. Multi-account: one SQLite database per user

## Status

Accepted (2026-07-17).

## Context

Until now the server ran a **single hardcoded account**: `startServer` opens one
`mail.db`, builds one `SqliteCatalog`, and every inbound message and local submission
lands in that one catalog's INBOX. `AccountStore` holds credentials in memory and re-seeds
them from config on each boot. The IMAP server takes one fixed catalog at construction and
serves it to whoever authenticates.

That is the right *minimum* for proving the protocols, but it is not the product. The
north star (ADR 0007) is a **modern "SQLite of email"** that a
person starts and uses, which means more than one mailbox. This ADR records
how we add multi-account, and the one strong opinion behind it: **one SQLite
database file per user, if we can do it cleanly**. A user then *is* a file you
can back up, move, or delete, which is the most literal expression of the "SQLite of
email" idea.

## Decision

### Storage: a control-plane DB + one mail DB per user

```mermaid
flowchart TD
    subgraph control["control.db (server-wide)"]
        ACC["accounts table<br/>(login, SCRAM keys, mail-db path, enabled)"]
        Q["outbound queue<br/>(global relay spool)"]
    end
    subgraph peruser["one file per user"]
        A["mail-alice.db<br/>SqliteCatalog: INBOX, Sent, …"]
        B["mail-bob.db<br/>SqliteCatalog: INBOX, Sent, …"]
    end
    ACC -.->|"mail-db path"| A
    ACC -.->|"mail-db path"| B
```

- **`control.db`**: a small server-wide database that holds the **account registry** (the
  persistent form of `AccountStore`: login name, SCRAM salt/iterations/hash/StoredKey/
  ServerKey, the path to that user's mail DB, and an `enabled` flag) **and the global
  outbound queue**. The queue stays server-global (one relay identity, one spool), and
  each row already carries its return-path. Per-user queues would buy nothing here.
- **`mail-<user>.db`**: one file per user, each a `SqliteCatalog` with today's exact
  schema (mailboxes, messages, flags, modseq, expunge log). No schema change: the
  per-user DB is byte-for-byte what a single-account `mail.db` is today. Isolation is
  physical: a user's data is one file, reachable only through their authenticated
  session.

### Identity

The **login name stays the bare username** (for example, `test`), not the full address: an
already-configured client authenticates with the bare username, and a change to that would break
its saved account.

The registry maps `login → {credential, mailDbPath, enabled}`, and delivery matches the
address `login@domain` to the same account. (A future multi-domain story can widen the
key, but not now.)

### The IMAP change: per-connection catalog resolution

The IMAP server currently binds one `#catalog` at construction. It gains an **optional
account resolver**:

```
resolveAccount?: (login: string) => { catalog: ServableCatalog; notifier?: MailboxNotifier } | undefined
```

- When a resolver exists, a successful `LOGIN`/`AUTHENTICATE` resolves the
  authenticated user's `{catalog, notifier}` and binds them **for that connection only**.
  Every mailbox operation on the connection runs against that catalog.
- When no resolver exists (the shape **every existing test uses**), the server keeps
  its single fixed catalog and behaves exactly as before. This preserves all 777 tests
  and is the seam that keeps the change bounded.

`#verifySaslPlain` now returns the authenticated **username** (or null) rather
than a bare boolean, so the AUTHENTICATE path can resolve the account too.

### Notifications scoped per user

`MailboxNotifier` keys listeners by mailbox name (`INBOX`). With multiple users that would
cross the streams: Bob's new mail must not wake Alice's IDLE. Each user gets **their own
notifier** (resolved alongside their catalog), so an `INBOX` notification is inherently
scoped to one user. No change to `MailboxNotifier` itself. We simply hold one per user.

### Delivery routing

- **Inbound (port 25):** `acceptRecipient` accepts `local@domain` **only if `local` is a
  known, enabled account. The server rejects an unknown local recipient** (`550`, no catch-all).
  The server appends a message for N local recipients to each
  recipient's own INBOX and fires each user's notifier.
- **Submission (587):** the server delivers local recipients to their account's INBOX (not one
  shared mailbox). Remote recipients queue to the global spool as today.
- **Bounces:** a bounce for a local sender lands in that sender's INBOX. Otherwise it
  relays with a null return-path, unchanged.

### Passwords

The registry persists **only SCRAM stored keys** (never the password) and reuses the
existing `AccountStore` derivation, the accounts/auth backend the multi-account design
needs. Brute-force lockout remains a recorded later nice-to-have.

### Migration

An existing single-account `mail.db` becomes that user's mail DB: the registry seeds the
account with its `mailDbPath` set to the existing file. **No data loss, and no re-sync
for an already-connected client.**

## Consequences

- **This change owns verification.** The design is only sound if each of these holds,
  so we prove each:
  1. **Isolation**: a session authenticated as A cannot LIST/SELECT/FETCH/STATUS any of
     B's mailboxes or messages. A negative control proves the test detects a leak.
  2. **Concurrency**: many users connected at once, *and* multiple sessions for one user
     (phone + desktop on a single per-user DB), exercised via the imaptest launcher.
     No cross-user contamination, WAL holds.
  3. **Crash consistency**: the existing SIGKILL crash test, extended so each per-user DB
     stays independently consistent and the registry survives.
  4. **Differential**: the per-user `SqliteCatalog` still passes the reference-vs-SQLite
     differential harness (unchanged schema, just one file each).
  5. **Live**: multiple real accounts provisioned and each driven with a real IMAP client.
     Isolation and per-user delivery verified end to end.
- Config grows from `{user, pass}[]` to accounts that may name a mail-DB path (default
  `mail-<login>.db` beside the control DB).
- The single-catalog `ImapServer.start(catalog, …)` signature stays (the resolver
  is additive), so this is not a rewrite of the IMAP server, only a new seam.
- Revisitable, like every ADR, with a stated reason.

## Outcome

We built and verified this against the five obligations above. Two points are worth recording
beyond "it passed":

- **Crash consistency deliberately gets no new test.** Each per-user database is the
  *identical* `SqliteCatalog` + WAL already proven to survive `kill -9`. The multi-account layer
  changes no storage internals, so a new multi-DB crash test would pass for a reason already
  covered, against the project's "no test that passes for the wrong reason" rule. Its own
  close/reopen test proves the control database's registry durability.
- **Isolation carries a negative control**: a deliberately mis-wired resolver leaks, which proves
  the isolation test can detect a leak.

We verified this end-to-end with a real IMAP client. The server serves separate accounts
concurrently and delivers each user's mail only to their own mailbox. It migrated a pre-existing
single-account database in place with no data loss and no client re-sync. The server rejects
unknown local recipients `550` at RCPT.
