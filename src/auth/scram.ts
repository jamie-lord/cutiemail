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

import { pbkdf2Sync, createHmac, createHash } from 'node:crypto';

export type ScramHash = 'sha1' | 'sha256';

const DK_LEN: Record<ScramHash, number> = { sha1: 20, sha256: 32 };

/** Hi(str, salt, i): PBKDF2 with HMAC-`hash`, output one hash block. */
export function hi(password: string, salt: Buffer, iterations: number, hash: ScramHash): Buffer {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, DK_LEN[hash], hash);
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
  return digest(recoveredClientKey, hash).equals(stored);
}
