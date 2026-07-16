/**
 * The conformance test case: the unit that binds a wire exchange to the register.
 *
 * A test case is not a function that asserts. It is a piece of DATA that says:
 * "to check requirement R, drive this exchange against the server, then apply
 * this expectation to what came back." Keeping it data — not code — is what makes
 * three things possible that a pile of assertion functions could not:
 *
 *   - Traceability is structural. `requirement` is a RequirementId, so a test
 *     citing a requirement that does not exist fails to COMPILE. There is no way
 *     to write an untraceable test. (Task #10's core ask.)
 *   - The coverage report (task #21) can read which requirements have tests
 *     without running anything.
 *   - The same case runs against Postfix, Exim, Stalwart, Mox — the driver is
 *     the variable, the case is fixed. (Tasks #23, #24.)
 *
 * The deliberate cost: an expectation may only observe (a `Conn`) and conclude
 * (a `Judgement`). It cannot reach the register, cannot decide its own Outcome,
 * cannot see other tests. Outcome is computed centrally from Judgement + Level
 * (see outcome.ts), so a test author cannot accidentally grade a SHOULD as a
 * failure. The narrow interface is the guardrail.
 */

import type { RequirementId } from '../register/rfc5321.ts';
import type { Wire } from '../wire/transport.ts';
import type { Reply } from '../wire/reply.ts';
import type { Judgement } from './outcome.ts';
import type { Fixture } from './fixture.ts';
import type { SinkView } from './sink.ts';

/**
 * The connection view handed to a test body.
 *
 * Thin on purpose: it is the transport plus SMTP-shaped conveniences (send a
 * command, read a reply). It does not interpret conformance — that is the
 * expectation's job — and it never repairs bytes.
 */
export interface Conn {
  /** Send exact bytes. Nothing appended. */
  send(bytes: Buffer): Promise<void>;
  /** Read one reply, or a non-framed outcome (timeout/closed/reset). */
  readReply(timeoutMs?: number): Promise<ReplyOutcome>;
  /** Assert the server stays silent for `ms` — for §2.4 "take no action". */
  expectQuiet(ms: number): Promise<{ quiet: boolean; bytes: Buffer }>;
  /** STARTTLS upgrade in place. Caller must have done the 220 handshake. */
  startTls(): Promise<void>;
  /** The full byte transcript, for evidence. */
  readonly wire: Wire;
  /** Resolved fixture values for this run (addresses, domains). */
  readonly fixture: Fixture;
  /**
   * The receiving sink, when the run provides one: a read-back view of the
   * messages the server under test relayed downstream. Present only for runs
   * configured with a sink (the mutant relay harness, or a real server told to
   * relay to our sink). A test that needs it declares `needs.sink` and yields
   * inconclusive when it is absent — never a false finding.
   */
  readonly sink?: SinkView;
}

export type ReplyOutcome =
  | { readonly kind: 'reply'; readonly reply: Reply }
  | { readonly kind: 'timeout'; readonly waitedMs: number; readonly partial: Buffer }
  | { readonly kind: 'closed'; readonly partial: Buffer }
  | { readonly kind: 'reset'; readonly partial: Buffer };

/**
 * The precondition a test needs from the server before it can conclude anything.
 *
 * This is the seam to the hard problem (task #12). A test that needs a valid
 * recipient declares it here; if the run has no such fixture the case yields
 * `inconclusive`, never a false failure. Declaring needs as data (not asserting
 * them mid-body) lets the runner skip-with-reason up front and lets the coverage
 * report show what is gated on fixtures we do not yet have.
 */
export interface Needs {
  /** Extension keywords that must appear in EHLO, or the case is inconclusive. */
  readonly ehlo?: readonly string[];
  /** Fixture capabilities required (a valid recipient, a rejected recipient…). */
  readonly fixture?: readonly (keyof Fixture)[];
  /** TLS must be available (implicit or STARTTLS). */
  readonly tls?: boolean;
  /**
   * A receiving sink must be available — the run must be able to observe what the
   * server relayed downstream. Without one (a plain run against a server we cannot
   * make relay to us), a sink-based case is inconclusive.
   */
  readonly sink?: boolean;
}

export interface TestCase {
  /** Stable, unique, kebab-case. Appears in every result and the matrix. */
  readonly id: string;
  /** The requirement this case exists to check. Compile-time checked. */
  readonly requirement: RequirementId;
  /**
   * A second-and-further requirements a single exchange also bears on. Kept
   * separate from `requirement` so the primary intent stays singular and the
   * coverage report does not double-count a test as deep coverage of five things.
   */
  readonly alsoTouches?: readonly RequirementId[];
  /** One sentence, for the report: what a human should understand this checks. */
  readonly intent: string;
  /** Citation into the RFC/register justifying the expectation. Required. */
  readonly rationale: string;
  readonly needs?: Needs;
  /**
   * Drive the exchange and judge it. May ONLY observe and conclude — see the
   * file header. Throw only on genuine harness faults; a server behaving badly
   * is a `Judgement`, not an exception.
   */
  readonly run: (conn: Conn) => Promise<Judgement>;
}

/**
 * A negative control: the same requirement, but proven to FAIL against a server
 * that violates it. Pairs a TestCase with a mutant configuration (task #25).
 *
 * A wire-testable requirement with a TestCase but no Mutant is only half-covered:
 * we have shown the test passes clean servers, not that it catches dirty ones. A
 * conformance suite that has never been shown to detect a violation is faith, not
 * evidence. The coverage report enforces this.
 */
export interface Mutant {
  /** The test that must catch this mutant. */
  readonly catches: string;
  /** The mutant server switch to enable (resolved by the mutant harness). */
  readonly defect: string;
  /** Why this defect violates the requirement — the link back to the spec. */
  readonly why: string;
  /**
   * Further requirements this SAME defect demonstrably proves detection of — a
   * DELIBERATE, per-claim declaration, not automatic credit.
   *
   * Coverage never credits a requirement merely because a test `alsoTouches` it
   * and some OTHER requirement's mutant fires (that was the finding-#6 hole). But
   * a single defect genuinely is the violation of several requirements at once
   * when they state the same wire behaviour in different sections — e.g. a mutant
   * that makes NOOP answer "500 command not recognized" proves both "NOOP is in
   * the minimum implementation" AND "producing not-recognized for the required
   * subset is a violation". This field is the reviewed escape hatch: each entry
   * carries its own `why`, so the claim is auditable exactly like `catches` is.
   * The requirement must be one the caught test's exchange actually exercises.
   */
  readonly alsoProves?: readonly { readonly requirement: RequirementId; readonly why: string }[];
}

/** Author a test case with compile-time requirement checking. Identity helper. */
export function testCase(tc: TestCase): TestCase {
  return tc;
}

/**
 * Convenience: run the standard opening (read greeting, send EHLO, read it) and
 * hand back the EHLO reply. Most cases start here; the ones that test the
 * greeting or EHLO itself do not, and call the primitives directly.
 */
export async function openSession(conn: Conn, ehloDomain: string): Promise<ReplyOutcome> {
  const greeting = await conn.readReply();
  if (greeting.kind !== 'reply') return greeting;
  await conn.send(Buffer.from(`EHLO ${ehloDomain}\r\n`, 'latin1'));
  return conn.readReply();
}
