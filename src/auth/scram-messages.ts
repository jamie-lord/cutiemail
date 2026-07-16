/**
 * SCRAM message parsing and nonce-continuation checks (RFC 5802 §5.1), with defects.
 *
 * Parses the three exchange messages around the proof crypto (scram.ts) and enforces
 * the nonce-continuation rules that prevent a splice or replay across
 * authentications. Bytes in; the SCRAM messages are ASCII by construction.
 */

export interface ClientFirst {
  readonly gs2Header: string; // e.g. "n,,"
  readonly username: string; // n=
  readonly nonce: string; // r=
}

export interface ServerFirst {
  readonly nonce: string; // r= (client nonce + server nonce)
  readonly salt: string; // s= (base64)
  readonly iterations: number; // i=
}

export interface ClientFinal {
  readonly channelBinding: string; // c= (base64)
  readonly nonce: string; // r=
  readonly proof: string; // p= (base64)
}

/** Split "k=v,k=v,..." attributes (after an optional leading GS2 header) into a map. */
function attrs(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (!m.has(part.slice(0, eq))) m.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return m;
}

export function parseClientFirst(message: Buffer): ClientFirst {
  const s = message.toString('latin1');
  // GS2 header is the first two comma-separated fields (flag, authzid).
  const parts = s.split(',');
  const gs2Header = `${parts[0] ?? ''},${parts[1] ?? ''},`;
  const bare = parts.slice(2).join(',');
  const a = attrs(bare);
  return { gs2Header, username: a.get('n') ?? '', nonce: a.get('r') ?? '' };
}

export function parseServerFirst(message: Buffer): ServerFirst {
  const a = attrs(message.toString('latin1'));
  return { nonce: a.get('r') ?? '', salt: a.get('s') ?? '', iterations: Number(a.get('i') ?? '0') };
}

export function parseClientFinal(message: Buffer): ClientFinal {
  const a = attrs(message.toString('latin1'));
  return { channelBinding: a.get('c') ?? '', nonce: a.get('r') ?? '', proof: a.get('p') ?? '' };
}

export interface NonceDefects {
  /** Skip the client-side server-nonce prefix check. Violates R-5802-5.1-a. */
  readonly skipNonceCheck?: boolean;
  /** Accept a client-final nonce that differs from the server's. Violates R-5802-5.1-b. */
  readonly acceptMismatchedNonce?: boolean;
}

/**
 * Client-side (R-5802-5.1-a): the server-first nonce must BEGIN WITH the client
 * nonce and add something of its own.
 */
export function verifyServerNonce(clientNonce: string, serverNonce: string, defects: NonceDefects = {}): boolean {
  if (defects.skipNonceCheck === true) return true;
  return serverNonce.startsWith(clientNonce) && serverNonce.length > clientNonce.length;
}

/**
 * Server-side (R-5802-5.1-b): the client-final nonce must EQUAL the full nonce the
 * server issued.
 */
export function verifyClientNonce(serverNonce: string, clientFinalNonce: string, defects: NonceDefects = {}): boolean {
  if (defects.acceptMismatchedNonce === true) return true;
  return serverNonce === clientFinalNonce;
}
