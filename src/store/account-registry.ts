/**
 * The persistent account registry — the SQLite form of `AccountStore` (accounts.ts),
 * plus the routing a multi-account server needs: which database file holds each user's
 * mail, and whether the account is enabled.
 *
 * It mirrors `AccountStore` exactly for the security-critical part — it persists only
 * SCRAM StoredKey/ServerKey, never the password (derived through the single shared
 * `deriveCredential`, so the two stores cannot drift) — and adds `mailDbPath`/`enabled`.
 * This is the control-plane table of ADR 0009: one row per login, pointing at that
 * user's `mail-<login>.db`.
 *
 * The login key is the bare username (not the full address), matching what the deployed
 * client authenticates as; delivery resolves `login@domain` to the same row.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveCredential } from './accounts.ts';
import type { ScramHash } from '../auth/scram.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  login        TEXT PRIMARY KEY,
  salt         BLOB NOT NULL,
  iterations   INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  stored_key   BLOB NOT NULL,
  server_key   BLOB NOT NULL,
  mail_db_path TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
);
-- Aliases are control-plane routing, not identity (ADR 0014): an additional address whose
-- mail lands in the owning login's mailbox. Stored lower-cased so the PRIMARY KEY IS the
-- case-insensitive uniqueness constraint. No per-alias storage — a user is still one file.
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  login TEXT NOT NULL
);
-- App-specific passwords (ADR 0017): named, server-generated, independently-revocable
-- credentials for one login. Each stores its OWN SCRAM material (never the secret), exactly
-- like the primary, so a device can authenticate without holding the primary password and can
-- be revoked alone. Keyed (login, name); login is the canonical account login.
CREATE TABLE IF NOT EXISTS app_passwords (
  login      TEXT NOT NULL,
  name       TEXT NOT NULL,
  salt       BLOB NOT NULL,
  iterations INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  stored_key BLOB NOT NULL,
  server_key BLOB NOT NULL,
  created    INTEGER NOT NULL,
  PRIMARY KEY (login, name)
);
`;

/** A resolved account's routing — what the server needs after (or independent of) auth. */
export interface AccountRow {
  readonly login: string;
  readonly mailDbPath: string;
  readonly enabled: boolean;
}

interface RawRow {
  login: string;
  salt: Uint8Array;
  iterations: number;
  hash: string;
  stored_key: Uint8Array;
  server_key: Uint8Array;
  mail_db_path: string;
  enabled: number;
}

interface RawCredential {
  salt: Uint8Array;
  iterations: number;
  hash: string;
  stored_key: Uint8Array;
}

/** A named app-specific password's metadata (never its secret). */
export interface AppPasswordRow {
  readonly name: string;
  readonly created: number;
}

// RFC 7677 §3.1 sets 4096 only as the FLOOR; OWASP's current guidance for PBKDF2-HMAC-SHA256
// is 600,000. 4096 is ~5 orders of magnitude too low against a stolen control DB / backup
// (GPU cracking runs at hundreds of millions of guesses/sec at 4096) — SCRAM's "server stores
// no password" property is worthless with a weak KDF. Stored per-row, so existing accounts
// re-derive at this cost on their next password change.
const DEFAULT_ITERATIONS = 600_000;
const DEFAULT_HASH: ScramHash = 'sha256';

/**
 * Generate a strong app-specific password: 144 bits from the CSPRNG, base64url (24 chars, no
 * padding, copy-pasteable). App passwords are never memorised — a client stores them — so an
 * unambiguous typed format is not needed; entropy and a clean charset are. Far above the
 * human-password floor, which is why app passwords bypass that length policy.
 */
export function generateAppPassword(): string {
  return randomBytes(18).toString('base64url');
}

export class AccountRegistry {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(db: DatabaseSync): AccountRegistry {
    db.exec(SCHEMA);
    return new AccountRegistry(db);
  }

  /**
   * Create or replace an account. Derives and stores only SCRAM keys — the password is
   * used transiently. A fresh random salt is generated unless one is supplied (tests pin
   * it). `enabled` defaults true.
   */
  upsert(
    login: string,
    password: string,
    mailDbPath: string,
    opts: { salt?: Buffer; iterations?: number; hash?: ScramHash; enabled?: boolean } = {},
  ): void {
    const salt = opts.salt ?? randomBytes(16);
    const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
    const hash = opts.hash ?? DEFAULT_HASH;
    const { storedKey, serverKey } = deriveCredential(password, salt, iterations, hash);
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO accounts (login, salt, iterations, hash, stored_key, server_key, mail_db_path, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(login, salt, iterations, hash, storedKey, serverKey, mailDbPath, opts.enabled === false ? 0 : 1);
  }

  /** Enable or disable an account (a disabled account fails auth and is not routable). */
  setEnabled(login: string, enabled: boolean): void {
    this.#db.prepare('UPDATE accounts SET enabled = ? WHERE login = ?').run(enabled ? 1 : 0, login);
  }

  #row(login: string): RawRow | undefined {
    return this.#db.prepare('SELECT * FROM accounts WHERE login = ?').get(login) as RawRow | undefined;
  }

  /** The routing for a login, or undefined if unknown. Includes disabled accounts. */
  lookup(login: string): AccountRow | undefined {
    const r = this.#row(login);
    return r === undefined ? undefined : { login: r.login, mailDbPath: r.mail_db_path, enabled: r.enabled === 1 };
  }

  /** Every account, oldest-inserted first — used at startup to open each user's mail DB. */
  list(): readonly AccountRow[] {
    const rows = this.#db.prepare('SELECT login, mail_db_path, enabled FROM accounts ORDER BY rowid').all() as Array<{
      login: string;
      mail_db_path: string;
      enabled: number;
    }>;
    return rows.map((r) => ({ login: r.login, mailDbPath: r.mail_db_path, enabled: r.enabled === 1 }));
  }

  // -- Aliases (ADR 0014) ------------------------------------------------------------------

  /** The enabled account this login names, or undefined (case-insensitive). */
  #enabledLoginFor(lcLocal: string): string | undefined {
    const r = this.#db.prepare('SELECT login FROM accounts WHERE lower(login) = ? AND enabled = 1').get(lcLocal) as
      | { login: string }
      | undefined;
    return r?.login;
  }

  /** The enabled owner of this alias, or undefined. `lcAlias` is already lower-cased. */
  #enabledOwnerOfAlias(lcAlias: string): string | undefined {
    const r = this.#db.prepare('SELECT login FROM aliases WHERE alias = ?').get(lcAlias) as { login: string } | undefined;
    if (r === undefined) return undefined;
    return this.lookup(r.login)?.enabled === true ? r.login : undefined;
  }

  /**
   * Resolve a recipient LOCAL-part to the owning ENABLED login, or undefined (ADR 0014).
   * The single routing chokepoint: an exact login, then an exact alias, then a `base+tag`
   * subaddress whose base is a login or alias. Case-insensitive throughout. undefined means
   * "not one of ours" → the caller rejects it (no catch-all, no backscatter).
   */
  resolveLocalPart(local: string): string | undefined {
    const lc = local.toLowerCase();
    const direct = this.#enabledLoginFor(lc);
    if (direct !== undefined) return direct;
    const viaAlias = this.#enabledOwnerOfAlias(lc);
    if (viaAlias !== undefined) return viaAlias;
    // Subaddressing: `base+tag` (one '+', non-empty base) delivers to `base`'s mailbox.
    const plus = lc.indexOf('+');
    if (plus > 0) {
      const base = lc.slice(0, plus);
      return this.#enabledLoginFor(base) ?? this.#enabledOwnerOfAlias(base);
    }
    return undefined;
  }

  /** Whether a name is already a login or an alias (case-insensitive) — enforces one-namespace uniqueness. */
  nameTaken(name: string): 'login' | 'alias' | undefined {
    const lc = name.toLowerCase();
    if (this.#db.prepare('SELECT 1 FROM accounts WHERE lower(login) = ?').get(lc) !== undefined) return 'login';
    if (this.#db.prepare('SELECT 1 FROM aliases WHERE alias = ?').get(lc) !== undefined) return 'alias';
    return undefined;
  }

  /** Add an alias (stored lower-cased) pointing at an owning login. Callers check collisions first. */
  addAlias(alias: string, login: string): void {
    this.#db.prepare('INSERT INTO aliases (alias, login) VALUES (?, ?)').run(alias.toLowerCase(), login);
  }

  /** Remove an alias; true if a row was deleted. */
  removeAlias(alias: string): boolean {
    return this.#db.prepare('DELETE FROM aliases WHERE alias = ?').run(alias.toLowerCase()).changes > 0;
  }

  /** The aliases owned by a login, sorted. */
  aliasesFor(login: string): readonly string[] {
    const rows = this.#db.prepare('SELECT alias FROM aliases WHERE login = ? ORDER BY alias').all(login) as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }

  /** Every alias with its owner, for `alias list`. */
  allAliases(): ReadonlyArray<{ readonly alias: string; readonly login: string }> {
    return this.#db.prepare('SELECT alias, login FROM aliases ORDER BY login, alias').all() as Array<{ alias: string; login: string }>;
  }

  // -- App-specific passwords (ADR 0017) ---------------------------------------------------

  /** Whether `name` already names an app password for `login` (case-sensitive, like the name). */
  appPasswordNameTaken(login: string, name: string): boolean {
    return this.#db.prepare('SELECT 1 FROM app_passwords WHERE login = ? AND name = ?').get(login, name) !== undefined;
  }

  /**
   * Create a named app-specific password for a login: generate a strong secret (unless one is
   * supplied — tests pin it), store only its SCRAM material, and RETURN the plaintext ONCE so
   * the caller can show it. The secret is never stored or recoverable. Callers check the account
   * exists and the name is free first.
   */
  addAppPassword(login: string, name: string, created: number, opts: { secret?: string; salt?: Buffer; iterations?: number } = {}): string {
    const secret = opts.secret ?? generateAppPassword();
    const salt = opts.salt ?? randomBytes(16);
    const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
    const { storedKey, serverKey } = deriveCredential(secret, salt, iterations, DEFAULT_HASH);
    this.#db
      .prepare('INSERT INTO app_passwords (login, name, salt, iterations, hash, stored_key, server_key, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(login, name, salt, iterations, DEFAULT_HASH, storedKey, serverKey, created);
    return secret;
  }

  /** Revoke a named app password; true if one was deleted. */
  removeAppPassword(login: string, name: string): boolean {
    return this.#db.prepare('DELETE FROM app_passwords WHERE login = ? AND name = ?').run(login, name).changes > 0;
  }

  /** An account's app passwords (names + created), newest first. Never the secret. */
  listAppPasswords(login: string): readonly AppPasswordRow[] {
    const rows = this.#db.prepare('SELECT name, created FROM app_passwords WHERE login = ? ORDER BY created DESC, name').all(login) as Array<{ name: string; created: number }>;
    return rows.map((r) => ({ name: r.name, created: Number(r.created) }));
  }

  #appCredentials(login: string): RawCredential[] {
    return this.#db.prepare('SELECT salt, iterations, hash, stored_key FROM app_passwords WHERE login = ?').all(login) as unknown as RawCredential[];
  }

  /** Re-derive StoredKey from the password and compare it against a stored credential (constant-time). */
  #credentialMatches(password: string, cred: RawCredential): boolean {
    const { storedKey } = deriveCredential(password, Buffer.from(cred.salt), cred.iterations, cred.hash as ScramHash);
    const expected = Buffer.from(cred.stored_key);
    return storedKey.length === expected.length && timingSafeEqual(storedKey, expected);
  }

  /**
   * Verify a plaintext password (SASL PLAIN over TLS) against the account's credentials, by
   * re-deriving StoredKey and comparing. A disabled or unknown account always fails. The primary
   * password is tried first, then each of the login's app-specific passwords (ADR 0017) — so an
   * app password authenticates everywhere the primary does and is gated by the same enabled
   * check and per-IP throttle. No password is ever stored. (An account with N app passwords costs
   * up to N+1 PBKDF2 derivations on a wrong guess; N is a handful of devices at this scale, and
   * the per-IP throttle bounds probing.)
   */
  verifyPassword(login: string, password: string): boolean {
    const r = this.#row(login);
    if (r === undefined || r.enabled !== 1) return false;
    if (this.#credentialMatches(password, r)) return true;
    for (const cred of this.#appCredentials(r.login)) {
      if (this.#credentialMatches(password, cred)) return true;
    }
    return false;
  }
}
