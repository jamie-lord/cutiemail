/**
 * RFC 5321 §2.3.9 – §2.3.11 — SMTP Terminology (second half)
 *
 * Covers:
 *   2.3.9  Message Content and Mail Data
 *   2.3.10 Originator, Delivery, Relay, and Gateway Systems
 *   2.3.11 Mailbox and Address
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * §2.3.9 yields no entries. It is three sentences of pure definition — it says
 * what "message content" and "mail data" name (the octets between DATA being
 * accepted and the end-of-data indication), that content includes header
 * section and body, and that RFC 2045 supplies the structuring mechanisms. No
 * sentence binds a party's behaviour, and none carries a keyword. The section
 * was read line by line; the absence is a finding, not a gap.
 *
 * These sections are mostly a taxonomy, and taxonomy is where the register
 * earns its keep: the normative force here is smuggled into definitions
 * ("a relay ... transmits it, without modification"), and it binds roles
 * (relay, gateway) that we cannot tell apart from a socket.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_3_B = [
  {
    id: 'R-5321-2.3.10-a',
    section: '2.3.10',
    page: 15,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'prose',
    text:
      'A "relay" SMTP system (usually referred to just as a "relay") receives ' +
      'mail from an SMTP client and transmits it, without modification to the ' +
      'message data other than adding trace information, to another SMTP ' +
      'server for further relaying or for delivery.',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether a relay modified the message data is visible only at the ' +
        'next hop, never in the replies we receive. Would need a receiving ' +
        'sink plus a server configured to relay to it — a different tool. ' +
        'Same shape as R-5321-2.4-d and R-5321-2.4-i; revisit together if ' +
        'task #12 grows an outbound sink.',
    },
    note:
      'DERIVED, hence `prose`: written as a definition ("a relay ... receives ' +
      'mail ... and transmits it, without modification"), not as a rule. The ' +
      'force is nonetheless MUST NOT, and the RFC supplies its own proof — ' +
      'the next paragraph (R-5321-2.3.10-b) speaks of transformations "that ' +
      'are not permitted to SMTP relay systems", which only parses if this ' +
      'definition is a prohibition. Compare §2.4\'s "in violation of this ' +
      'specification" anchor. ' +
      'The prohibition is narrower than it reads: "other than adding trace ' +
      'information" licenses the Received: line §4.4 separately REQUIRES, and ' +
      'it bounds only the MESSAGE DATA, so envelope rewriting is untouched by ' +
      'it. A test author who reads this as "a relay must emit byte-identical ' +
      'mail" would fail every conforming relay in existence. ' +
      'Note also that this binds the relay ROLE, and a server does not tell us ' +
      'which role it is playing — the same daemon relays for one domain and ' +
      'delivers for another. Even with a sink, the test would have to ' +
      'establish that the path under test is a relay path and not a gateway ' +
      'path, since R-5321-2.3.10-b exempts gateways from exactly this rule.',
  },
  {
    id: 'R-5321-2.3.10-b',
    section: '2.3.10',
    page: 15,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Differences in protocols or message semantics between the transport ' +
      'environments on either side of a gateway may require that the gateway ' +
      'system perform transformations to the message that are not permitted ' +
      'to SMTP relay systems.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission, so unfailable, and it concerns transformations we ' +
        'cannot observe from the client side anyway (see R-5321-2.3.10-a). ' +
        'Compounding it, nothing on the wire declares a server to be a ' +
        'gateway rather than a relay, so we could not even establish that the ' +
        'permission applies.',
    },
    note:
      'TRAP: the "may" here is lowercase and is NOT an RFC 2119 keyword. §1.3 ' +
      'scopes 2119 force to the capitalised terms only, so this is `prose`, ' +
      'and the "may" is doing descriptive work ("differences ... may require") ' +
      'rather than granting anything. We register it at MAY because its ' +
      'subordinate clause is where the permission actually lives: gateways are ' +
      'exempt from the modification ban that binds relays. ' +
      'Registered separately from R-5321-2.3.10-a despite sharing a subject, ' +
      'because it binds a different role and inverts the obligation — a ' +
      'transformation that condemns a relay exonerates a gateway. That is also ' +
      'why R-5321-2.3.10-a can never be tested by observation alone: the ' +
      'defence "I am a gateway" is always available and is not falsifiable ' +
      'over SMTP.',
  },
  {
    id: 'R-5321-2.3.10-c',
    section: '2.3.10',
    page: 15,
    level: 'SHOULD',
    party: 'both',
    normativeSource: 'prose',
    text:
      'For the purposes of this specification, firewalls that rewrite ' +
      'addresses should be considered as gateways, even if SMTP is used on ' +
      'both sides of them (see RFC 2979 [27]).',
    testability: {
      kind: 'not-testable',
      reason:
        'A classification rule addressed to the reader of the specification, ' +
        'not a behaviour any party performs. There is no wire event ' +
        'corresponding to considering something a gateway — same category as ' +
        'R-5321-2.4-o ("MUST NOT be construed as authorization").',
    },
    note:
      'TRAP, twice over. First, "should" is lowercase and therefore not a 2119 ' +
      'SHOULD (§1.3); `prose` at SHOULD level records the force it plainly ' +
      'has without pretending the keyword is there. A grep for capitalised ' +
      'keywords misses this line entirely, which is precisely why EXTRACTING ' +
      'says to read every line. ' +
      'Second, it looks actionable and is not. Its real effect is on the ' +
      'register itself rather than on any test: it widens R-5321-2.3.10-b\'s ' +
      'exemption to cover address-rewriting firewalls, which is a large share ' +
      'of the SMTP-speaking middleboxes we might ever point this suite at. ' +
      'Kept for that reason — deleting it would leave R-5321-2.3.10-a looking ' +
      'more testable than it is.',
  },
  {
    id: 'R-5321-2.3.11-a',
    deliberatelyUncovered: {
      reason:
        'distinguishing a relayed from a locally-delivered local-part needs a domain the server relays for plus recipients it treats differently at RCPT, which is server-side routing state not creatable in-band and not modelled by the mutant.',
      date: '2026-07-22',
    },
    section: '2.3.11',
    page: 16,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'the local-part MUST be interpreted and assigned semantics only by the ' +
      'host specified in the domain part of the address.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A domain the server under test relays for rather than delivers to ' +
        'locally, plus a pair of recipients in that domain whose local-parts ' +
        'are syntactically valid per §4.1.2 but unusual (a quoted string, a ' +
        'leading dot, "postmaster" vs an arbitrary token). Differential ' +
        'treatment at RCPT time is the signal. Requires server-side state we ' +
        'cannot create in-band — see task #12.',
    },
    note:
      'Text spans the page 15/16 boundary in spec/rfc5321.txt; it starts after ' +
      'the [Page 15] marker at line 842, so it takes page 16. Quoted from "the ' +
      'local-part MUST be" rather than from the head of the sentence: the ' +
      'preamble ("Consequently, and due to a long history of problems when ' +
      'intermediate hosts have attempted to optimize transport by modifying ' +
      'them") is rationale, not requirement. Worth reading anyway — it names ' +
      'the failure mode this MUST exists to prevent, and it is the same ' +
      '"intermediate hosts being clever" hazard behind R-5321-2.4-d.\n' +
      'Testability is claimed at `wire-with-fixture` but is thin, and the ' +
      'thinness is the point of writing it down:\n' +
      '  - Only violations are detectable. A server that accepts every ' +
      '    local-part proves nothing; it may have no opinion, or it may have ' +
      '    an opinion it never gets to apply. There is no passing observation ' +
      '    here, only a failing one.\n' +
      '  - Interpreting is invisible; only acting on an interpretation shows. ' +
      '    A relay may parse a local-part to its heart\'s content provided the ' +
      '    parse changes nothing.\n' +
      '  - The delivery server IS "the host specified in the domain part", so ' +
      '    it is exempt by construction. Point this test at a normal MX for ' +
      '    its own domain and it asserts nothing whatsoever. The relay fixture ' +
      '    is not a convenience; without it there is no requirement in scope.\n' +
      'The false-positive risk is severe. SYNTAX validation is permitted ' +
      '(§4.1.2 defines Local-part, and §2.3.10 relays plainly must parse the ' +
      'envelope), and SEMANTICS is the forbidden thing — a distinction that ' +
      'has no bright line at the wire. A recipient-verification callout ' +
      'DELEGATES to the domain host and so honours this MUST rather than ' +
      'breaking it, despite looking, from our side, exactly like a relay ' +
      'forming an opinion about a local-part. Likewise address-rewriting ' +
      'firewalls, which R-5321-2.3.10-c reclassifies as gateways and thereby ' +
      'moves outside this rule. A naive test would fail Exim for doing its ' +
      'job. Assert only on the flagrant case (a relay rejecting a ' +
      'syntactically valid local-part for a domain it does not own, with a ' +
      'reply that names the local-part as the reason) and expect to spend ' +
      'longer on the fixture than on the assertion.',
  },
] as const satisfies readonly RequirementDef[];
