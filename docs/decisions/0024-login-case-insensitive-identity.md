# 0024. A login is case-insensitive identity, enforced by the database

## Status

Accepted (2026-07-24). Names an invariant four earlier decisions each assumed and none owned,
after the halves disagreed in production code.

## Context

A login is the account's name (ADR 0009), the thing a client authenticates as, the local-part
mail is routed to (ADR 0014), the key app passwords hang off (ADR 0017), and the argument every
`account` verb takes (ADR 0012). It is also the filename: each user's mail lives in
`mail-<login>.db`.

That last point settles the question on its own. On a case-insensitive filesystem — macOS by
default, some container volumes — `mail-Alice.db` and `mail-alice.db` are one file, so two
accounts differing only in case would silently share a mailbox while holding different
credentials. `account add` and `init` have refused such a pair for that reason since ADR 0012.

But refusing to *create* the pair is not the same as agreeing what a login *is*. The routing
path compared `lower(login)`; the authentication path compared the login exactly. Both had been
correct in isolation for as long as they existed, and the disagreement between them was
invisible: mail addressed to `ALICE@` was delivered to `alice`, while `AUTH` as `ALICE` failed.
Disabling an account with the wrong spelling matched no row at all and reported success, so an
operator responding to a compromise could disable nothing and be told it worked.

Making the reads case-insensitive then exposed the other half of the same gap. Writes still
keyed on the spelling the caller typed, so `set-password ALICE` passed a case-insensitive
existence check and then inserted a *second* row past the case-sensitive primary key: the
rotation silently did nothing and the old password kept working. A convention that every call
site has to remember is not an invariant.

## Decision

### Case is a display property of a login, never part of its identity

Every login-keyed operation folds case: authentication, routing, enable/disable, aliases, app
passwords, the store cache, and the `account` CLI all resolve any spelling to one account. The
registry stores whatever spelling the login was created with, and reports *that* spelling back —
so `account add ALICE` against an existing `alice` says which account it collided with — but no
decision anywhere is made on the difference.

### The database enforces it, not the call sites

`accounts` carries `UNIQUE INDEX accounts_login_nocase ON accounts (lower(login))`, and writes
store the canonical spelling. A future statement that forgets to fold case now fails loudly at
the insert instead of quietly forking an account in two. This is the whole point of the record:
the bug above was not a missing check, it was a missing constraint.

### Opening a split registry fails, with the pair named

A registry that already holds two such logins — reachable through the `MAIL_ACCOUNTS` env seed
before that path was guarded — cannot satisfy the index, so `AccountRegistry.open` throws and
the daemon refuses to start, naming the colliding pair and what to do about it. Refusing to boot
beats booting into the state the index exists to prevent: those two accounts were already
sharing one mailbox file, with authentication and password changes able to land on different
rows. [The deployment guide](../DEPLOYMENT.md) carries the recovery steps.

## Consequences

- A user whose client capitalises their username can log in. Previously they could not, while
  mail addressed to that same capitalisation was delivered to them — the worst kind of
  half-working.
- An operator can type any spelling to any `account` verb and reach the account they meant.
- One upgrade can fail to start, loudly and with instructions, on a registry that was already
  broken. That is a deliberate trade: the alternative is continuing to run a configuration in
  which a password rotation may not take effect.
- There is deliberately no `account remove` (ADR 0012), so resolving a split pair means moving
  the losing account's mail into the survivor over IMAP and deleting its row by hand. That cost
  falls only on registries that are already in this state.
- Aliases are unaffected in substance: they were always stored lower-cased and matched
  case-insensitively (ADR 0014). What changes is that logins now follow the same rule for
  matching, so the two namespaces are compared consistently in both directions.
- App-password *names* stay case-sensitive. Only the login side folds; a name is a label the
  operator chose, not an identity the system routes on.
