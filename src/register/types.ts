/**
 * The requirement register: every normative requirement in RFC 5321, with a stable
 * ID, the verbatim text, and an honest statement of whether we can test it.
 *
 * This file defines the shape. `rfc5321.ts` holds the entries.
 *
 * Why this exists: the project's central claim is that we know what has been
 * implemented, what works, and why. That claim is only checkable if there is a
 * fixed denominator to check it against. This is that denominator.
 *
 * See docs/decisions/0001-spec-baseline.md.
 */

/**
 * The vendored spec files a requirement can be quoted from, and therefore checked
 * against by a verbatim gate. One entry per file in spec/. Adding an RFC here + the
 * file in spec/ is all a new register domain needs from the shared shape.
 */
export type SpecSource =
  | 'rfc5321'
  | 'rfc3207'
  | 'rfc5322'
  | 'rfc5802'
  | 'rfc2045'
  | 'rfc2046'
  | 'rfc2047'
  | 'rfc6376'
  | 'rfc8463'
  | 'rfc7208'
  | 'rfc7489'
  | 'rfc8461'
  | 'rfc8617'
  | 'rfc6531'
  | 'rfc9051';

/** RFC 2119 / RFC 8174 normative levels, as they appear in the source RFCs. */
export type Level =
  | 'MUST'
  | 'MUST NOT'
  | 'SHOULD'
  | 'SHOULD NOT'
  | 'MAY'
  | 'REQUIRED'
  | 'RECOMMENDED';

/**
 * Which side of the conversation the requirement binds.
 *
 * This suite connects *to* a server, so it can only ever observe receiver
 * behaviour. Client-binding requirements are still registered — deleting them
 * would shrink the denominator and flatter our coverage.
 */
export type Party = 'server' | 'client' | 'both';

/**
 * Where the normative force comes from.
 *
 * Most requirements carry an RFC 2119 keyword. A few are stated as plain prose
 * that nonetheless defines conformance — e.g. §2.4's "A few SMTP servers, in
 * violation of this specification ... require that command verbs be encoded by
 * clients in upper case", which makes case-sensitive verb handling a violation
 * without ever writing "MUST".
 *
 * Marking these honestly matters: a reader must be able to tell where we are
 * quoting the RFC and where we are interpreting it.
 */
export type NormativeSource = 'keyword' | 'prose';

/** Can this suite actually assert the requirement, and how? */
export type Testability =
  /** Assertable with a bare connection and no server-side setup. */
  | { readonly kind: 'wire' }
  /**
   * Assertable by feeding an input to an IN-PROCESS parser/engine and checking the
   * result — no server, no socket. This is the library-adapter shape used by the
   * message-format (RFC 5322/MIME), address-parsing and mail-crypto registers: the
   * corpus is a set of (input bytes -> expected outcome) cases run against whatever
   * implementation is put behind a thin adapter interface.
   */
  | { readonly kind: 'parse' }
  /**
   * Assertable by driving OUR OWN reference SMTP delivery client against a
   * scripted peer and observing the protocol it emits. This is the mirror of the
   * mutant-server pattern: a reference client with switchable defects is the
   * system under test, a scripted server (conformant or adversarial) is the peer,
   * and the corpus asserts the client's on-the-wire behaviour. It exists because a
   * client-binding requirement ("the client MUST transmit CRLF only", "MUST NOT
   * send data after a 5yz") is invisible to the RECEIVER conformance suite — which
   * connects outward to a third-party server and can only observe the server — but
   * is directly observable when we are the one driving the client. See
   * docs/decisions/0008-outbound-client-harness.md.
   */
  | { readonly kind: 'wire-client' }
  /**
   * Assertable, but needs known server-side state (a mailbox that must be
   * accepted, a domain we do/don't relay for, a quota). SMTP gives almost no
   * way to establish this in-band — see task #12, the hard problem.
   */
  | { readonly kind: 'wire-with-fixture'; readonly fixture: string }
  /**
   * Not assertable by this suite, with the reason stated. Covers client-binding
   * requirements, requirements about internal or operational behaviour
   * ("SHOULD be documented"), and anything needing out-of-band observation.
   */
  | { readonly kind: 'not-testable'; readonly reason: string };

/**
 * A deliberate decision NOT to cover a testable requirement.
 *
 * The distinction this encodes is the whole point of the register: "we decided
 * not to, for this reason" is a good answer; "we never noticed" is not. Absence
 * of coverage without one of these is a gap, and the report (task #21) says so.
 */
export interface DeliberatelyUncovered {
  readonly reason: string;
  /** ISO date the decision was taken, so stale reasoning is visible. */
  readonly date: string;
}

export interface RequirementDef {
  /** Stable ID: R-<rfc>-<section>-<letter>. Never renumber; retire instead. */
  readonly id: string;
  /**
   * Which RFC the `text` is quoted from, and therefore which spec file the
   * verbatim gate checks it against. Defaults to rfc5321 (the vast majority);
   * rfc3207 is the STARTTLS Secure-SMTP extension (the security surface RFC 5321
   * itself does not cover).
   */
  readonly rfc?: SpecSource;
  /** Section within the source RFC, e.g. "2.3.8" or (for rfc3207) "4.2". */
  readonly section: string;
  /** Page in the source spec .txt, for locating the text by hand. */
  readonly page: number;
  readonly level: Level;
  readonly party: Party;
  readonly normativeSource: NormativeSource;
  /**
   * The requirement, quoted verbatim from spec/rfc5321.txt. Trimmed of line
   * wrapping only — no paraphrasing, no cleanup. If you find yourself wanting
   * to reword it, that belongs in `note`.
   */
  readonly text: string;
  readonly testability: Testability;
  /** Extraction judgement, scope calls, known traps. */
  readonly note?: string;
  /**
   * How draft-ietf-emailcore-rfc5321bis treats this requirement. Populated by
   * task #3. A bis clarification is a strong hint that implementations diverge
   * here, which makes it a high-value test target.
   */
  readonly bisNote?: string;
  readonly deliberatelyUncovered?: DeliberatelyUncovered;
}

/**
 * Narrow the id union from the const array so a test citing a non-existent
 * requirement is a compile error rather than a runtime lookup miss.
 */
export type IdsOf<T extends readonly RequirementDef[]> = T[number]['id'];
