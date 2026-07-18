# 0012 — Accounts are provisioned by CLI; env vars seed create-only

## Status

Accepted (2026-07-18). Backlog item B3 (docs/BACKLOG.md), evidence-based: the SCRAM
registry was designed to store only StoredKey/ServerKey, and this closes the hole
that undermined it.

## Context

Since ADR 0009 the control database's account registry stores only SCRAM
StoredKey/ServerKey — never a password. But accounts were *provisioned* by
re-feeding plaintext passwords through `MAIL_USER`/`MAIL_PASS`/`MAIL_ACCOUNTS` on
every boot, which means:

- every password lives permanently, in plaintext, in the systemd unit file (and in
  the process environment, visible to anything that can read
  `/proc/<pid>/environ`);
- every boot **overwrote** the stored credential from the env, so a password
  rotated in the registry would be silently reverted by the next restart.

The careful key-derivation design was only as strong as its weakest input path.

## Decision

1. **`node src/main.ts account add|set-password|enable|disable|list`** writes the
   registry directly. Passwords are read from a hidden prompt (twice, must match)
   or one line of stdin when piped — never from argv, which is world-readable via
   `ps`. The daemon consults the registry per auth/delivery operation, so changes
   apply live with no restart (the WAL journal keeps the CLI writer and the
   daemon's readers out of each other's way).
2. **Env accounts become CREATE-ONLY seeds.** If the login does not exist, it is
   created (dev ergonomics: `npm start` still works out of the box, and a first
   deploy can bootstrap the primary account from the unit file). If it exists, the
   registry wins: a differing env password is **ignored with a logged warning**
   naming the fix (`account set-password`). A matching env password logs nothing —
   no false alarm on every boot.
3. **There is deliberately no `remove` verb.** Deleting the registry row would
   discard only the salt/keys while the user's `mail-<login>.db` remained on disk —
   a half-destruction that looks clean. `disable` refuses auth and inbound
   delivery, destroys nothing, and reverses cleanly; actually deleting a user's
   mail is an explicit `rm` of their database file, not something a management
   verb should do as a side effect.
4. **Login names are validated** (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`): a login
   becomes a filename fragment (`mail-<login>.db`), so path metacharacters are
   refused, as are the `MAIL_ACCOUNTS` delimiters (`:`, `,`) and `@`.

## Consequences

- A production unit file needs **no passwords at all** once accounts exist; the
  recommended flow is `account add` per user, with the env vars reserved for dev
  and first-boot bootstrap.
- Operators who previously rotated passwords by editing `MAIL_PASS` and
  restarting will see a warning telling them the env password is now ignored —
  the behaviour change is visible, not silent.
- Live-verified (2026-07-18, mailtest box): an account added by CLI while the
  daemon was running authenticated over IMAPS immediately, no restart, no
  password anywhere in the environment.

## Follow-up (2026-07-18)

`node src/main.ts init <login>` operationalises the passwordless bootstrap: a
first-run-only command that creates the primary account from a hidden prompt
(refusing once any account exists) and prints a unit with no password in it. To
catch a lingering plaintext seed, both `doctor` and the daemon at startup now warn
when `MAIL_PASS`/`MAIL_ACCOUNTS` are set but the account already exists (the seed is
redundant) — turning point 2's "reserve env for bootstrap" from advice into a
visible nudge.
