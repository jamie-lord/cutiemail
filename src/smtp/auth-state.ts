/**
 * A reference SMTP submission AUTH state machine (RFC 4954 §4 + ADR 0007), with
 * switchable defects.
 *
 * Decides whether an AUTH command is allowed given the session state. The RFC
 * sequencing rules (not during a transaction, not twice) plus the opinionated
 * no-plaintext-AUTH-without-TLS rule are all enforced here. A pure decision
 * function over the session state — testable before the live submission server
 * exists, which must reproduce these decisions.
 *
 * This is NOT dead reference code: the production receiver (src/server/smtp-receiver.ts,
 * Connection.#auth) CALLS canAuth for the AUTH sequencing decision, so this module is
 * the single source of truth for it rather than a parallel copy that can silently
 * diverge. The receiver keeps its own wire replies (enhanced status codes + text);
 * canAuth decides only accept-or-refuse and which rule fired.
 */

export interface SessionState {
  /** True once STARTTLS has established a TLS layer. */
  readonly tlsActive: boolean;
  /** True once an AUTH has already succeeded this session. */
  readonly authenticated: boolean;
  /** True once MAIL FROM has opened a transaction. */
  readonly inTransaction: boolean;
}

export interface AuthStateDefects {
  /** Allow AUTH during a mail transaction. Violates R-4954-4-a. */
  readonly allowAuthInTransaction?: boolean;
  /** Allow a second AUTH after one succeeded. Violates R-4954-4-b. */
  readonly allowReauth?: boolean;
  /** Allow AUTH on a cleartext (non-TLS) connection. Violates the ADR-0007 no-plaintext rule. */
  readonly allowCleartextAuth?: boolean;
}

export interface AuthDecision {
  readonly accepted: boolean;
  /** The SMTP reply code that would be sent (334 to proceed, else a rejection code). */
  readonly code: number;
  readonly reason: string;
}

/** Decide whether an AUTH command is permitted in the given state. */
export function canAuth(state: SessionState, defects: AuthStateDefects = {}): AuthDecision {
  // ADR 0007: no plaintext AUTH — refuse on a cleartext connection (538 = enc required).
  if (!state.tlsActive && defects.allowCleartextAuth !== true) {
    return { accepted: false, code: 538, reason: 'encryption required before AUTH (ADR 0007)' };
  }
  // R-4954-4-a: not during a transaction.
  if (state.inTransaction && defects.allowAuthInTransaction !== true) {
    return { accepted: false, code: 503, reason: 'AUTH not permitted during a mail transaction' };
  }
  // R-4954-4-b: not twice.
  if (state.authenticated && defects.allowReauth !== true) {
    return { accepted: false, code: 503, reason: 'already authenticated' };
  }
  return { accepted: true, code: 334, reason: 'proceed with SASL exchange' };
}
