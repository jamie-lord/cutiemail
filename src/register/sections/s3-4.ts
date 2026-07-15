/**
 * RFC 5321 §3.4 — Forwarding for Address Correction or Updating
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Section character: this is one of the most permission-dense sections in the
 * document. Of seven entries, five are MAY and the RFC deliberately offers
 * *paired* alternatives at each fork (251-or-250, 551-or-550). Almost nothing
 * here can be failed. The two MUST NOTs both bind an internal assumption
 * ("MUST NOT assume that the client will...") rather than a wire act, and the
 * single SHOULD is about shipping a configuration knob. A naive extraction sees
 * "251"/"551"/"550" and imagines a rich reply-code test suite; the honest
 * reading is that §3.4 is mostly guidance to implementers, and the register
 * should say so rather than pad the numerator.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_4 = [
  {
    id: 'R-5321-3.4-a',
    section: '3.4',
    page: 22,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Consequently, the "forwarding" mechanisms described in Section 3.2 of ' +
      'RFC 821, and especially the 251 (corrected destination) and 551 reply ' +
      'codes from RCPT must be evaluated carefully by implementers and, when ' +
      'they are available, by those configuring systems (see also Section 7.4).',
    testability: {
      kind: 'not-testable',
      reason:
        'An instruction to human implementers and operators to think carefully. ' +
        'There is no wire event corresponding to having evaluated something ' +
        'carefully, and no reply code distinguishes a considered choice from a ' +
        'careless one.',
    },
    note:
      'Marked `prose`, not `keyword`, deliberately: the "must" here is LOWERCASE ' +
      'in the RFC. Under RFC 2119/8174 conventions only the capitalised form ' +
      'carries defined normative force, so this is not an RFC 2119 MUST — but ' +
      'the sentence still reads as an obligation on implementers, which is why ' +
      'it is registered at all rather than dropped as narrative. `level: MUST` ' +
      'records the force it has in plain English, NOT a claim that the RFC ' +
      'capitalised it. Quoted from "Consequently," (the sentence opener on ' +
      'page 22) so the quote is anchored and unique. ' +
      'Text spans the page 21/22 boundary; the sentence STARTS on page 22, ' +
      'hence page 22.',
  },
  {
    id: 'R-5321-3.4-b',
    section: '3.4',
    page: 22,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Servers MAY forward messages when they are aware of an address change.',
    testability: {
      kind: 'not-testable',
      reason:
        'A permission to forward, and forwarding is by definition invisible to ' +
        'the client — the whole point of the preceding paragraphs is that the ' +
        '"final" address is not exposed through SMTP. A 250 from a forwarding ' +
        'server and a 250 from a directly-delivering server are identical on ' +
        'the wire. Confirming a forward would need a receiving sink at the ' +
        'far end, which is a different tool.',
    },
    note:
      'The blanket permission; R-5321-3.4-c is the conditional that governs HOW ' +
      'it is signalled, and that one is at least partly observable. Kept ' +
      'separate because they bind different acts (forwarding vs. announcing ' +
      'the forward) and have different testability.',
  },
  {
    id: 'R-5321-3.4-c',
    section: '3.4',
    page: 22,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When they do so, they MAY either provide address-updating information ' +
      'with a 251 code, or may forward "silently" and return a 250 code.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient address the server is configured to forward to a different ' +
        'final address (an alias or a "new address" redirect). Requires ' +
        'server-side state we cannot create in-band — see task #12.',
    },
    note:
      'TRAP FOR TEST AUTHORS: this is an explicit either/or permission, so ' +
      'BOTH 251 and 250 are conformant and neither can be failed. Do not write ' +
      'a test that expects 251 for a known alias — silent forwarding with 250 ' +
      'is not merely tolerated, §3.4\'s own opening paragraph says it "is common ' +
      'in the contemporary Internet", and §3.4-g exists precisely so sites can ' +
      'turn 251 off. In practice almost every deployed MTA returns 250. ' +
      'The most a test may assert is the negative: IF a 251 arrives for a ' +
      'forwarded recipient it must carry address-updating information, and the ' +
      'outcome for either branch is `permitted-latitude` (task #9). ' +
      'Note the RFC\'s own asymmetric casing — "MAY either ... or may" ' +
      '(lowercase second "may") — quoted as printed, not a transcription slip.',
  },
  {
    id: 'R-5321-3.4-d',
    section: '3.4',
    page: 22,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, if a 251 code is used, they MUST NOT assume that the client ' +
      'will actually update address information or even return that ' +
      'information to the user.',
    testability: {
      kind: 'not-testable',
      reason:
        'Prohibits the server from holding an ASSUMPTION about what the client ' +
        'will do with the 251. An internal belief has no wire representation; ' +
        'the server behaves identically whether or not it harbours it. Its ' +
        'only observable consequence would be a server that stops forwarding ' +
        'after one 251 on the theory the client updated its records — and ' +
        'proving that requires state across transactions plus knowledge of the ' +
        'server\'s intent, not just its replies.',
    },
    note:
      'Looks testable (it names a concrete reply code and says MUST NOT) and ' +
      'is not — the same family as §2.4\'s "MUST NOT be construed as ' +
      'authorization". Registered because deleting it would flatter the ' +
      'denominator. ' +
      'Quoted with "if a 251 code is used" included: R-5321-3.4-g is a ' +
      'word-for-word twin of this sentence apart from 551-for-251, so the ' +
      'reply code is the ONLY thing making either quote unique. Do not shorten ' +
      'either quote.',
  },
  {
    id: 'R-5321-3.4-e',
    section: '3.4',
    page: 22,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Servers MAY reject messages or return them as non-deliverable when they ' +
      'cannot be delivered precisely as addressed.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient that cannot be delivered precisely as addressed — an ' +
        'address the server knows has moved, or a mailbox that exists only ' +
        'under a corrected form.',
    },
    note:
      'The "Alternately," fork: the RFC offers this as an alternative posture to ' +
      'R-5321-3.4-b, so a server that forwards and a server that rejects are ' +
      'both conformant. Two named options within the permission as well ' +
      '(reject at RCPT/DATA vs. accept and bounce), and the bounce branch is ' +
      'invisible from the client side. Unfailable; expect `permitted-latitude`.',
  },
  {
    id: 'R-5321-3.4-f',
    section: '3.4',
    page: 22,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When they do so, they MAY either provide address-updating information ' +
      'with a 551 code, or may reject the message as undeliverable with a 550 ' +
      'code and no address-specific information.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the server rejects because it cannot be delivered as ' +
        'addressed, where a corrected address is known to the server. Requires ' +
        'server-side state we cannot create in-band — see task #12.',
    },
    note:
      'The rejection-side twin of R-5321-3.4-c, with the same trap: 551 and 550 ' +
      'are both explicitly conformant, so a test MUST NOT expect 551 for a ' +
      'known-moved address. Deployed servers overwhelmingly return 550 — §7.4 ' +
      'treats address disclosure as a privacy hazard and R-5321-3.4-h lets ' +
      'sites disable 551 outright. ' +
      'Assertable only as a conditional: IF 551, THEN address-updating ' +
      'information must be present; the 550 branch explicitly carries "no ' +
      'address-specific information", which is itself a weak positive check.',
  },
  {
    id: 'R-5321-3.4-g',
    section: '3.4',
    page: 22,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'However, if a 551 code is used, they MUST NOT assume that the client ' +
      'will actually update address information or even return that ' +
      'information to the user.',
    testability: {
      kind: 'not-testable',
      reason:
        'Same as R-5321-3.4-d: prohibits an internal assumption about client ' +
        'behaviour, which has no representation on the wire. The server\'s ' +
        'replies are identical whether or not it holds the assumption.',
    },
    note:
      'Word-for-word identical to R-5321-3.4-d except "551" for "251". ' +
      'Registered as a separate entry because the RFC states it separately ' +
      'under a separate bullet, and because the 550/551 rejection path and the ' +
      '250/251 forwarding path are independently implementable — a server may ' +
      'support one code and not the other. The reply code is the only ' +
      'discriminator between the two quotes; shortening either would make both ' +
      'ambiguous.',
  },
  {
    id: 'R-5321-3.4-h',
    section: '3.4',
    page: 22,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP server implementations that support the 251 and/or 551 reply codes ' +
      'SHOULD provide configuration mechanisms so that sites that conclude ' +
      'that they would undesirably disclose information can disable or ' +
      'restrict their use.',
    testability: {
      kind: 'not-testable',
      reason:
        'A requirement on the software\'s configuration surface, not on its ' +
        'protocol behaviour. Whether a knob exists is discoverable from the ' +
        'documentation or the source, never from a socket — and a server that ' +
        'never emits 251/551 is indistinguishable from one where the knob is ' +
        'simply turned off, which is the conformant state this SHOULD is ' +
        'designed to make reachable.',
    },
    note:
      'The "SHOULD be documented / SHOULD be configurable" genre named in ' +
      'types.ts as a canonical not-testable case. Worth noting the direction of ' +
      'travel this encodes: the RFC gives 251/551 with one hand and, citing the ' +
      'privacy discussion in §7.4, tells implementers to let sites take them ' +
      'away with the other. Only implementations that DO support 251/551 are ' +
      'bound — a server that never emits them is out of scope of this sentence ' +
      'entirely, not in violation of it. That conditional antecedent is a ' +
      'second reason no wire test could exist: we cannot establish the ' +
      'antecedent without already having observed a 251 or 551.',
  },
] as const satisfies readonly RequirementDef[];
