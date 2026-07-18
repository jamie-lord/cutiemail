/**
 * A reference SCRAM account store (RFC 5802 §1), with a defect.
 *
 * Persists per-user SCRAM credentials — salt, iteration count, StoredKey and
 * ServerKey — and authenticates a client proof against them via the SCRAM crypto
 * (src/auth/scram.ts). The defining property is that the stored information is
 * NOT the password and is not enough to impersonate the user: this is the store the
 * SQLite account table must mirror. Passwords are handled only transiently, at
 * setPassword time, to derive the keys.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { hi, storedKey, verifyClientProof, type ScramHash } from '../auth/scram.ts';

/** ServerKey = HMAC(SaltedPassword, "Server Key"). */
function serverKeyOf(saltedPassword: Buffer, hash: ScramHash): Buffer {
  return createHmac(hash, saltedPassword).update('Server Key').digest();
}

/**
 * Derive the SCRAM keys a store persists — StoredKey and ServerKey — from a password
 * and its salt/iterations/hash. The single point that turns a password into stored
 * material, so the in-memory `AccountStore` and the SQLite `AccountRegistry` can never
 * disagree about what a credential is. Returns no copy of the password.
 */
export function deriveCredential(password: string, salt: Buffer, iterations: number, hash: ScramHash): { storedKey: Buffer; serverKey: Buffer } {
  const salted = hi(password, salt, iterations, hash);
  return { storedKey: storedKey(salted, hash), serverKey: serverKeyOf(salted, hash) };
}

export interface StoredCredential {
  readonly salt: Buffer;
  readonly iterations: number;
  readonly hash: ScramHash;
  readonly storedKey: Buffer;
  readonly serverKey: Buffer;
  /** Present ONLY under the storePlaintextPassword defect — a conformant store never keeps this. */
  readonly password?: string;
}

export interface AccountDefects {
  /** Persist the plaintext password alongside the derived keys. Violates R-5802-1-a. */
  readonly storePlaintextPassword?: boolean;
}

export class AccountStore {
  readonly #creds = new Map<string, StoredCredential>();

  /** Set a user's password, deriving and storing only the SCRAM keys (not the password). */
  setPassword(username: string, password: string, salt: Buffer, iterations: number, hash: ScramHash, defects: AccountDefects = {}): void {
    const { storedKey: sk, serverKey: svk } = deriveCredential(password, salt, iterations, hash);
    const cred: StoredCredential = {
      salt,
      iterations,
      hash,
      storedKey: sk,
      serverKey: svk,
      ...(defects.storePlaintextPassword === true ? { password } : {}),
    };
    this.#creds.set(username, cred);
  }

  /** The stored credential for a user, or undefined. Exposed so tests can inspect what is persisted. */
  credential(username: string): StoredCredential | undefined {
    return this.#creds.get(username);
  }

  /** Authenticate a SCRAM client proof against the stored key. */
  authenticate(username: string, authMessage: string, clientProof: Buffer): boolean {
    const c = this.#creds.get(username);
    if (c === undefined) return false;
    return verifyClientProof(c.storedKey, authMessage, clientProof, c.hash);
  }

  /**
   * Verify a plaintext password (from SASL PLAIN over TLS) against the stored keys,
   * by re-deriving StoredKey from the password + stored salt/iterations. The stored
   * database still holds no password — the derivation is transient.
   */
  verifyPassword(username: string, password: string): boolean {
    const c = this.#creds.get(username);
    if (c === undefined) return false;
    const computed = storedKey(hi(password, c.salt, c.iterations, c.hash), c.hash);
    return computed.length === c.storedKey.length && timingSafeEqual(computed, c.storedKey);
  }
}
