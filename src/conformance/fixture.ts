/**
 * Preconditions: the hard problem, and the honest answer to it.
 *
 * This is why an SMTP conformance suite does not already exist. IMAP's imaptest
 * can build its own state through the protocol — create a mailbox, append a
 * message, then assert. SMTP gives you almost nothing: you cannot, over the
 * wire, tell a server "make a@example.com a valid recipient and b@example.com a
 * rejected one". A huge fraction of RFC 5321 is about how a server treats
 * recipients it accepts versus rejects, relays versus refuses, sizes it permits
 * versus denies — and none of that is observable without known server-side
 * state you had no in-band way to create.
 *
 * The answer is not to pretend. It is to make the required state an explicit,
 * operator-declared input, and to make its absence produce `inconclusive` — not
 * a pass (which would claim we tested something we didn't) and not a fail (which
 * would accuse a server of a defect we couldn't actually observe). "We could not
 * establish the precondition" is a first-class, honestly-reported state.
 *
 * This bounds what the suite can assert against a bare `host:port` with no
 * fixture: the connection-level, syntax-level and sequencing requirements — a
 * lot, but not the delivery-policy requirements. The coverage report shows
 * exactly which requirements are gated on fixtures the current run lacks, so the
 * boundary is visible rather than hidden.
 *
 * Three ways to supply the state, in declared order of fidelity:
 *   1. Operator declaration — a config file naming addresses/domains the
 *      operator has set up on the server under test. Highest fidelity, most
 *      setup. This is the model here.
 *   2. Convention — a required postmaster account and a reserved reject-domain
 *      the suite assumes. Lower setup, assumes the operator followed the
 *      convention. A fallback, recorded as lower-confidence.
 *   3. Companion sink — for OUTBOUND tests (does the server relay correctly),
 *      a receiving server we control. Out of scope for the inbound corpus;
 *      noted as the seam for later.
 */

/**
 * The server-side state a run has been told exists.
 *
 * Every field is optional. A field left unset means "the operator did not
 * declare this", which makes every test needing it `inconclusive`. Undeclared is
 * never guessed.
 */
export interface Fixture {
  /** The EHLO domain the suite announces as itself. Always available. */
  readonly clientDomain: string;

  /** An address the server MUST accept as a deliverable local recipient. */
  readonly validRecipient?: string;
  /** An address in a served domain that the server MUST reject (550/551/553). */
  readonly rejectedRecipient?: string;
  /** A domain the server is NOT authoritative for and will refuse to relay to. */
  readonly nonRelayDomain?: string;
  /** A domain the server relays for (if it relays at all; many MXs do not). */
  readonly relayDomain?: string;
  /** An address whose mailbox is over quota, for 452/552 tests. */
  readonly overQuotaRecipient?: string;
  /** The postmaster address — RFC 5321 §4.5.1 requires it be accepted. */
  readonly postmaster?: string;
  /**
   * A deliverable recipient whose LOCAL-PART is a full 64 octets — the §4.5.3.1.1
   * floor a receiver MUST accept. Must be otherwise valid so a rejection can only
   * be a length rejection, not "no such user".
   */
  readonly longLocalPartRecipient?: string;
  /**
   * A deliverable/relayable recipient whose DOMAIN approaches the §4.5.3.1.2 floor
   * of 255 octets. Must be otherwise acceptable so a rejection can only be a length
   * rejection.
   */
  readonly longDomainRecipient?: string;

  /** Declared SIZE limit in octets, if the operator knows it. */
  readonly declaredSizeLimit?: number;

  /** How this fixture was obtained, for confidence reporting. */
  readonly source: 'operator-declared' | 'convention' | 'none';
}

/** The always-available baseline: enough for connection/syntax/sequencing tests. */
export function baselineFixture(clientDomain: string): Fixture {
  return { clientDomain, source: 'none' };
}

/**
 * Check a fixture supplies every capability a test declared it needs.
 *
 * Returns the missing capabilities. Empty means satisfied. The runner turns a
 * non-empty result into an `inconclusive` result with these named — so the
 * report can say precisely "this requirement is untested here because no
 * validRecipient was declared", which is actionable, unlike a silent skip.
 */
export function missingCapabilities(
  fixture: Fixture,
  needed: readonly (keyof Fixture)[],
): readonly (keyof Fixture)[] {
  return needed.filter((cap) => fixture[cap] === undefined);
}

/**
 * The RFC 5321 §4.5.1 minimum: a conformant server MUST support `postmaster`
 * with no domain and MUST accept mail to `postmaster@its-own-domain`. This is
 * the one recipient every server is REQUIRED to have, so it is the one fixture
 * we can assume without the operator declaring it — but only for the server's
 * own domain, which we still have to be told. Recorded as `convention`.
 */
export function withPostmasterConvention(fixture: Fixture, serverDomain: string): Fixture {
  if (fixture.postmaster !== undefined) return fixture;
  return {
    ...fixture,
    postmaster: `postmaster@${serverDomain}`,
    source: fixture.source === 'operator-declared' ? 'operator-declared' : 'convention',
  };
}

/**
 * Validate an operator-declared fixture for internal coherence before a run,
 * so a contradictory config fails fast rather than producing confusing results.
 */
export function validateFixture(fixture: Fixture): string[] {
  const problems: string[] = [];
  if (fixture.clientDomain.length === 0) {
    problems.push('clientDomain is required and must be non-empty');
  }
  if (
    fixture.validRecipient !== undefined &&
    fixture.rejectedRecipient !== undefined &&
    fixture.validRecipient === fixture.rejectedRecipient
  ) {
    problems.push('validRecipient and rejectedRecipient are the same address');
  }
  if (fixture.declaredSizeLimit !== undefined && fixture.declaredSizeLimit <= 0) {
    problems.push('declaredSizeLimit must be positive');
  }
  for (const field of ['validRecipient', 'rejectedRecipient', 'postmaster', 'overQuotaRecipient'] as const) {
    const v = fixture[field];
    if (v !== undefined && !v.includes('@')) {
      problems.push(`${field} "${v}" is not an address (no @)`);
    }
  }
  return problems;
}
