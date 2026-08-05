# 0024. A login is case-insensitive identity, enforced by the database

## Status

Accepted (2026-07-24). This ADR names an invariant that four earlier decisions each assumed
and none owned, after the two halves disagreed in production code.

## Context

A login is the account's name (ADR 0009). It is the identity a client authenticates as. It is
the local-part that mail routes to (ADR 0014), the key that app passwords attach to (ADR 0017),
and the argument that every `account` verb takes (ADR 0012). It is also the filename: each
user's mail lives in `mail-<login>.db`.

That last point settles the question on its own. On a case-insensitive filesystem — macOS by
default, some container volumes — `mail-Alice.db` and `mail-alice.db` are one file. So two
accounts that differ only in case would silently share a mailbox, while they hold different
credentials. Since ADR 0012, `account add` and `init` refuse such a pair for that reason.

But a refusal to *create* the pair is not the same as agreement on what a login *is*. The
routing path compared `lower(login)`. The authentication path compared the login exactly. Both
were correct in isolation for as long as they existed, and their disagreement was invisible.
The server delivered mail addressed to `ALICE@` to `alice`, while `AUTH` as `ALICE` failed. A
disable command with the wrong spelling matched no row at all and reported success. So an
operator who responded to a compromise could disable nothing, and the system told them it worked.

The change that made the reads case-insensitive then exposed the other half of the same gap.
Writes still keyed on the spelling the caller typed. So `set-password ALICE` passed a
case-insensitive existence check, and then inserted a *second* row past the case-sensitive
primary key. The rotation silently did nothing, and the old password stayed valid. A convention
that every call site has to remember is not an invariant.

## Decision

### Case is a display property of a login, never part of its identity

Every login-keyed operation folds case. Authentication, routing, enable/disable, aliases, app
passwords, the store cache, and the `account` CLI all resolve any spelling to one account. The
registry stores whatever spelling the operator created the login with, and reports *that*
spelling back. So `account add ALICE` against an existing `alice` says which account it collided
with. But the registry makes no decision anywhere on the difference.

### The database enforces it, not the call sites

`accounts` carries `UNIQUE INDEX accounts_login_nocase ON accounts (lower(login))`, and writes
store the canonical spelling. A future statement that forgets to fold case now fails loudly at
the insert, instead of a quiet fork of an account in two. This is the whole point of the record:
the bug above was not a missing check, it was a missing constraint.

### A split registry fails to open, with the pair named

A registry that already holds two such logins cannot satisfy the index. The `MAIL_ACCOUNTS` env
seed could reach that state before a guard closed that path. So `AccountRegistry.open` throws
and the daemon refuses to start. It names the colliding pair and what to do about it. A refusal
to boot beats a boot into the state the index exists to prevent. Those two accounts already
shared one mailbox file, and authentication and password changes could land on different rows.
[The deployment guide](../DEPLOYMENT.md) carries the recovery steps.

## Consequences

- A user whose client capitalises their username can log in. Previously they could not, while
  the server delivered mail addressed to that same capitalisation to them — the worst kind of
  half-working.
- An operator can type any spelling to any `account` verb and reach the account they meant.
- One upgrade can fail to start, loudly and with instructions, on a registry that was already
  broken. That is a deliberate trade. The alternative is to continue to run a configuration in
  which a password rotation may not take effect.
- There is deliberately no `account remove` (ADR 0012). So a fix for a split pair means you move
  the losing account's mail into the survivor over IMAP, and delete its row by hand. That cost
  falls only on registries that are already in this state.
- Aliases are not affected in substance: the registry always stored them lower-cased and matched
  them case-insensitively (ADR 0014). What changes is that logins now follow the same rule for
  matching. So the registry compares the two namespaces consistently in both directions.
- App-password *names* stay case-sensitive. Only the login side folds. A name is a label the
  operator chose, not an identity the system routes on.
