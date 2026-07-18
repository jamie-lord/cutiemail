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

// RFC 7677 §3.1 sets 4096 only as the FLOOR; OWASP's current guidance for PBKDF2-HMAC-SHA256
// is 600,000. 4096 is ~5 orders of magnitude too low against a stolen control DB / backup
// (GPU cracking runs at hundreds of millions of guesses/sec at 4096) — SCRAM's "server stores
// no password" property is worthless with a weak KDF. Stored per-row, so existing accounts
// re-derive at this cost on their next password change (audit run-4).
const DEFAULT_ITERATIONS = 600_000;
const DEFAULT_HASH: ScramHash = 'sha256';

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

  /**
   * Verify a plaintext password (SASL PLAIN over TLS) against the stored keys, by
   * re-deriving StoredKey from the password + the stored salt/iterations/hash and
   * comparing. A disabled or unknown account always fails. No password is stored.
   */
  verifyPassword(login: string, password: string): boolean {
    const r = this.#row(login);
    if (r === undefined || r.enabled !== 1) return false;
    const { storedKey } = deriveCredential(password, Buffer.from(r.salt), r.iterations, r.hash as ScramHash);
    const expected = Buffer.from(r.stored_key);
    return storedKey.length === expected.length && timingSafeEqual(storedKey, expected);
  }
}
