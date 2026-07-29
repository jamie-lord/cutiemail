/**
 * SCRAM proof computation and verification (RFC 5802 §3), with a defect.
 *
 * The password-never-sent core of SCRAM: derive keys from the password with
 * PBKDF2, and prove knowledge via an HMAC/XOR construction. The server stores only
 * StoredKey and ServerKey, and verifies the client's proof without ever seeing the
 * password. All real crypto (node:crypto); parameterized by hash so the same code
 * serves SCRAM-SHA-1 (the RFC 5802 §5 vector) and SCRAM-SHA-256 (RFC 7677, the
 * production choice per ADR 0007).
 *
 * SASLprep normalisation of the password, the full message exchange/parsing, and
 * channel binding are later increments; this is the cryptographic heart.
 */

import { pbkdf2, pbkdf2Sync, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export type ScramHash = 'sha1' | 'sha256';

const DK_LEN: Record<ScramHash, number> = { sha1: 20, sha256: 32 };

const pbkdf2Async = promisify(pbkdf2);

/**
 * Hi(str, salt, i): PBKDF2 with HMAC-`hash`, output one hash block.
 *
 * Synchronous, and deliberately kept for the PROVISIONING path only — `account add`,
 * `set-password`, seeding — where one 55 ms pause in a CLI is nothing and simple code is worth
 * more. Anything on the VERIFICATION path must use `hiAsync`: see the note there.
 */
export function hi(password: string, salt: Buffer, iterations: number, hash: ScramHash): Buffer {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, DK_LEN[hash], hash);
}

/**
 * The same derivation, on libuv's threadpool instead of the event loop.
 *
 * The iteration count is deliberately high (600,000 — far above RFC 7677's floor) to make an
 * offline attack on stolen material expensive. That is the right call, and it is exactly why
 * this must not run on the main thread: it turns every credential check into ~55 ms of BLOCKING
 * work on the one thread that also serves inbound SMTP, submission and every other IMAP
 * session. Measured, one client looping logins with a single valid credential took the
 * unauthenticated port-25 greeting from 0 ms to over a second, because a *successful* auth costs
 * no throttle budget — correctly, since charging successes would let an attacker lock out
 * legitimate users (auth-throttle.ts). The cost had no bound, so the fix is to stop it being
 * loop time at all: same work, ~2 ms of loop lag instead of ~55.
 *
 * Dovecot runs slow password schemes in separate `auth-worker` processes and Postfix delegates
 * to `saslauthd` for the same reason; this is the zero-dependency equivalent.
 */
export async function hiAsync(password: string, salt: Buffer, iterations: number, hash: ScramHash): Promise<Buffer> {
  return pbkdf2Async(Buffer.from(password, 'utf8'), salt, iterations, DK_LEN[hash], hash);
}

const hmac = (key: Buffer, data: string | Buffer, hash: ScramHash): Buffer => createHmac(hash, key).update(data).digest();
const digest = (data: Buffer, hash: ScramHash): Buffer => createHash(hash).update(data).digest();

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** StoredKey = H(HMAC(SaltedPassword, "Client Key")) — what a server persists. */
export function storedKey(saltedPassword: Buffer, hash: ScramHash): Buffer {
  return digest(hmac(saltedPassword, 'Client Key', hash), hash);
}

/** ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage) (R-5802-3-a). */
export function computeClientProof(saltedPassword: Buffer, authMessage: string, hash: ScramHash): Buffer {
  const clientKey = hmac(saltedPassword, 'Client Key', hash);
  const stored = digest(clientKey, hash);
  const clientSignature = hmac(stored, authMessage, hash);
  return xor(clientKey, clientSignature);
}

/** ServerSignature = HMAC(HMAC(SaltedPassword, "Server Key"), AuthMessage) (R-5802-3-b). */
export function computeServerSignature(saltedPassword: Buffer, authMessage: string, hash: ScramHash): Buffer {
  const serverKey = hmac(saltedPassword, 'Server Key', hash);
  return hmac(serverKey, authMessage, hash);
}

export interface ScramVerifyDefects {
  /** Accept without actually checking the client proof. Violates R-5802-3-a. */
  readonly skipProofCheck?: boolean;
}

/**
 * Server-side verification: recover ClientKey from the proof and confirm it hashes
 * to the stored key. Never needs the password — only `stored` (StoredKey).
 */
export function verifyClientProof(
  stored: Buffer,
  authMessage: string,
  clientProof: Buffer,
  hash: ScramHash,
  defects: ScramVerifyDefects = {},
): boolean {
  if (defects.skipProofCheck === true) return true;
  const clientSignature = hmac(stored, authMessage, hash);
  const recoveredClientKey = xor(clientProof, clientSignature);
  // Constant-time compare — a credential check must not leak how much of the key matched.
  const recovered = digest(recoveredClientKey, hash);
  return recovered.length === stored.length && timingSafeEqual(recovered, stored);
}
