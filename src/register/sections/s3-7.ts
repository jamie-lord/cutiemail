/**
 * RFC 5321 §3.7 — Mail Gatewaying (and §§3.7.1–3.7.5)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Extraction note for the whole section: §3.7 is about GATEWAYS — systems at
 * the boundary between the Internet SMTP transport environment and some other
 * mail environment. Almost everything here binds what the gateway EMITS on its
 * far side (the foreign environment), which a suite that dials in over SMTP
 * cannot see at all. The honest result is that this section is mostly
 * `not-testable`, and that is worth stating loudly rather than dressing up:
 * §3.7 is a large slab of MUSTs that will never move our covered count.
 *
 * The two exceptions live in §3.7.2 — the trace-header robustness rules — and
 * they are among the most testable requirements in RFC 5321, because they bind
 * "receiving systems" generally rather than gateways specifically. See
 * R-5321-3.7.2-c.
 *
 * §3.7 itself (lines 1531-1546) yields no entries: it is definitional prose
 * ("we refer to it as a 'gateway'") plus an explicit disclaimer that gatewaying
 * "does not easily yield to standardization". Its "may require that an
 * intermediate SMTP server perform a translation function" is a descriptive
 * lowercase "may" about network topology, not a grant of permission to anyone.
 * Read in full; nothing normative found.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_7 = [
  {
    id: 'R-5321-3.7.1-a',
    section: '3.7.1',
    page: 28,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Header fields MAY be rewritten when necessary as messages are gatewayed ' +
      'across mail environment boundaries.',
    testability: {
      kind: 'not-testable',
      reason:
        'Rewriting is visible only in the message the gateway emits into the ' +
        'far environment, which by definition is not the SMTP session we are ' +
        'holding. A permission in any case, so unfailable even if we could see it.',
    },
    note:
      'Note the party: "server" here means the gateway acting as receiver of our ' +
      'session, but the permitted act happens on its egress. This is the shape of ' +
      'nearly every §3.7 requirement and the reason the section is a coverage ' +
      'desert. Do not be tempted to test it by sending a message and re-fetching ' +
      'it over IMAP: that measures the delivery path, not the gateway, and the ' +
      'suite has no such sink (cf. R-5321-2.4-d).',
  },
  {
    id: 'R-5321-3.7.1-b',
    section: '3.7.1',
    page: 28,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This may involve inspecting the message body or interpreting the ' +
      'local-part of the destination address in spite of the prohibitions in ' +
      'Section 6.4.',
    testability: {
      kind: 'not-testable',
      reason:
        'Grants relief from a prohibition. Whether a receiver inspected a body ' +
        'is not observable from the client side at all — the same blindness that ' +
        'makes R-5321-2.4-i untestable.',
    },
    note:
      'DERIVED, hence `prose`: a lowercase "may involve" that nonetheless carves ' +
      'a real exception out of §6.4\'s MUST NOT ("a relay SMTP has no need to ' +
      'inspect or act upon the header section or body ... and MUST NOT do so"). ' +
      'Conformance-defining because it changes what §6.4 forbids: a gateway that ' +
      'inspects a body is not in violation, whereas a plain relay doing the same ' +
      'thing is. Registered so the register does not later look like it thinks ' +
      '§6.4 is absolute. Also note the asymmetry it creates: a server we cannot ' +
      'identify as a gateway cannot be failed under §6.4 either, because it may ' +
      'be claiming this exception. That weakens any future §6.4 test more than it ' +
      'weakens this one.',
  },
  {
    id: 'R-5321-3.7.2-a',
    section: '3.7.2',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When forwarding a message into or out of the Internet environment, a ' +
      'gateway MUST prepend a Received: line,',
    testability: {
      kind: 'not-testable',
      reason:
        'The prepended line appears in the forwarded message, not in any reply ' +
        'the gateway sends us. Requires reading the message after the gateway ' +
        'has passed it on, which this suite has no path to.',
    },
    note:
      'Quoted with the trailing comma and split from the "but it MUST NOT alter" ' +
      'clause (R-5321-3.7.2-b): one sentence, two independent obligations — one ' +
      'to add, one to leave alone — and a gateway can plausibly satisfy either ' +
      'while breaking the other, so they must be countable separately.',
  },
  {
    id: 'R-5321-3.7.2-b',
    section: '3.7.2',
    page: 29,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'but it MUST NOT alter in any way a Received: line that is already in the ' +
      'header section.',
    testability: {
      kind: 'not-testable',
      reason:
        'Alteration of an existing trace line is only detectable by comparing ' +
        'the message before and after the gateway. We control the "before" but ' +
        'have no access to the "after".',
    },
    note:
      'The paragraph immediately following names the exact failure mode this ' +
      'forbids: "well-meaning gateways that try to \'fix\' a Received: line". ' +
      'That is a strong hint implementations really do this, which would make it ' +
      'a high-value target — but only for a tool positioned on the far side of ' +
      'the gateway. Worth flagging if the project ever grows an outbound sink.',
  },
  {
    id: 'R-5321-3.7.2-c',
    section: '3.7.2',
    page: 29,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'receiving systems MUST NOT reject mail based on the format of a trace ' +
      'header field',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient the system under test will accept mail for, so that a 2yz ' +
        'at end-of-DATA is achievable in the control case; plus a message whose ' +
        '"Received:" header field is syntactically malformed by RFC 5322 rules. ' +
        'Needs a control run with a well-formed Received: to prove the fixture ' +
        'itself is deliverable — otherwise a 5yz proves nothing.',
    },
    note:
      'THE testable requirement in §3.7. Note the subject: "receiving systems", ' +
      'not "gateways" — the obligation escapes the gatewaying context and binds ' +
      'every receiver, which is what makes it reachable from a plain SMTP dial-in. ' +
      'MUST NOT, so a rejection is a genuine FAIL, not permitted latitude. ' +
      'Traps for the test author: (1) the prohibition is specifically about ' +
      'FORMAT. A server rejecting for too many Received: lines is enforcing §6.3 ' +
      'loop detection and is not in violation — vary the syntax, never the count. ' +
      '(2) It says "reject mail", which covers rejection at end-of-DATA; it does ' +
      'not obviously cover silent discard after a 250, and a spam engine scoring ' +
      'a weird trace line into a quiet drop is indistinguishable from compliance ' +
      'on our side. We can only assert the 2yz, and should say so rather than ' +
      'claim more. (3) Do not use a Received: line that is malformed in a way ' +
      'that also breaks message framing (a bare LF, an 8-bit octet) — that ' +
      'triggers other rules and the result will be uninterpretable.',
  },
  {
    id: 'R-5321-3.7.2-d',
    section: '3.7.2',
    page: 29,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'and SHOULD be extremely robust in the light of unexpected information or ' +
      'formats in those header fields.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'Same as R-5321-3.7.2-c — an acceptable recipient plus a corpus of ' +
        'trace header fields carrying unexpected content (unknown "via"/"with" ' +
        'tokens, absurd lengths, unknown clauses).',
    },
    note:
      '"extremely robust" has no crisp failure condition — there is no reply ' +
      'code for insufficient robustness. The only unambiguous violations we can ' +
      'catch are the loud ones: a 4yz/5yz, a dropped connection, or a timeout ' +
      'on a message that differs from an accepted control only in trace-header ' +
      'weirdness. Anything short of that must be reported as pass, not as a ' +
      'judgement call. Kept separate from R-5321-3.7.2-c despite sharing a ' +
      'sentence and a fixture because the levels differ: rejecting on format is ' +
      'a FAIL (MUST NOT), while merely being brittle is `permitted-latitude` ' +
      '(SHOULD). Collapsing them would silently promote a SHOULD to a MUST.',
  },
  {
    id: 'R-5321-3.7.2-e',
    section: '3.7.2',
    page: 29,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The gateway SHOULD indicate the environment and protocol in the "via" ' +
      'clauses of Received header field(s) that it supplies.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns the content of a Received: header field the gateway writes ' +
        'into a forwarded message. Not present in any reply on our connection.',
    },
  },
  {
    id: 'R-5321-3.7.3-a',
    section: '3.7.3',
    page: 29,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'From the Internet side, the gateway SHOULD accept all valid address ' +
      'formats in SMTP commands and in the RFC 822 header section, and all valid ' +
      'RFC 822 messages.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'The system under test must be known, out of band, to be a gateway — ' +
        'nothing in SMTP announces this — and must have a recipient it accepts ' +
        'for. Then a corpus of valid-but-exotic address forms (quoted local-part, ' +
        'address literal, source route) in MAIL/RCPT.',
    },
    note:
      '"From the Internet side" is the one §3.7 obligation aimed at the gateway\'s ' +
      'INGRESS, i.e. at us — hence the only reason this is not flatly ' +
      'not-testable. But it is fenced by a fixture we cannot obtain in-band: ' +
      'gateway-ness is a deployment fact, and running this against a plain relay ' +
      'produces a result about the wrong requirement. Two further traps: the ' +
      'assertion is about VALID formats, so the corpus must be scrupulously ' +
      'RFC-valid — a test that smuggles in a form that only looks valid will fail ' +
      'good gateways; and §4.5.1 separately lets any server reject a RCPT for ' +
      'policy reasons, so a 550 here is ambiguous between "rejected the format" ' +
      'and "does not relay for that domain", which is exactly what this SHOULD ' +
      'is not about. Assert on 501/553 syntax rejections, not on 550 policy ones.',
  },
  {
    id: 'R-5321-3.7.3-b',
    section: '3.7.3',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Addresses and header fields generated by gateways MUST conform to ' +
      'applicable standards (including this one and RFC 5322 [4]).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds what the gateway generates on egress. Also unbounded in scope — ' +
        '"applicable standards" is not a finite checkable set, so even with an ' +
        'outbound sink this would not reduce to a single assertion.',
    },
    note:
      'Reference marker "[4]" quoted as printed. Worth noticing that this MUST is ' +
      'really a pointer to two entire specifications; it is the kind of ' +
      'requirement that inflates a denominator without ever being coverable. ' +
      'Registered anyway — the alternative is quietly deciding which MUSTs count.',
  },
  {
    id: 'R-5321-3.7.3-c',
    section: '3.7.3',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'Gateways are, of course, subject to the same rules for handling source ' +
      'routes as those described for other SMTP systems in Section 3.3.',
    testability: {
      kind: 'not-testable',
      reason:
        'Defines the SCOPE of §3.3\'s rules rather than stating a behaviour of ' +
        'its own. There is no wire event corresponding to "being subject to a ' +
        'rule"; the testable content lives entirely in the §3.3 entries.',
    },
    note:
      'DERIVED, hence `prose`: no keyword, and the "of course" makes it read as ' +
      'a reminder rather than an obligation — but it is conformance-defining, ' +
      'because without it a gateway could argue §3.3 addresses "other SMTP ' +
      'systems" and not itself. Same family as R-5321-2.4-o: it looks testable ' +
      'and is not, and it is kept in the register precisely for that reason. ' +
      'Whoever extracts §3.3 should NOT re-register its source-route rules here ' +
      'under gateway IDs — that would double-count the same obligation.',
  },
  {
    id: 'R-5321-3.7.4-a',
    section: '3.7.4',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The gateway MUST ensure that all header fields of a message that it ' +
      'forwards into the Internet mail environment meet the requirements for ' +
      'Internet mail.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns the message the gateway forwards onward, not the session it ' +
        'holds with us. Observable only from the far side of the gateway.',
    },
    note:
      'The umbrella MUST; the three that follow (b, c, d) are its named ' +
      'particulars, introduced by "In particular". Registered separately because ' +
      'the RFC states them separately and each is independently violable — but a ' +
      'coverage report should not read (b)+(c)+(d) as evidence about (a), which ' +
      'is broader than the three of them combined.',
  },
  {
    id: 'R-5321-3.7.4-b',
    section: '3.7.4',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'In particular, all addresses in "From:", "To:", "Cc:", etc., header ' +
      'fields MUST be transformed (if necessary) to satisfy the standard header ' +
      'syntax of RFC 5322 [4],',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the header fields of the forwarded message on the gateway\'s ' +
        'egress path. Nothing on our connection reflects the transformation.',
    },
    note:
      'One sentence, three MUSTs (b, c, d), split at the commas. Quoted with the ' +
      'trailing comma so the boundary with R-5321-3.7.4-c is unambiguous and the ' +
      'quote stays a contiguous substring. Note "(if necessary)" is part of the ' +
      'requirement, not an editorial aside — it is what stops this from ' +
      'mandating gratuitous rewriting of already-valid headers.',
  },
  {
    id: 'R-5321-3.7.4-c',
    section: '3.7.4',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'MUST reference only fully-qualified domain names,',
    testability: {
      kind: 'not-testable',
      reason:
        'A property of addresses in the forwarded message\'s header section, ' +
        'which we never see. Distinct from the envelope FQDN rules in §2.3.5 and ' +
        '§4.1.2, which are separately registered and are testable.',
    },
    note:
      'Short quote. Checked for uniqueness against the whole RFC: "MUST reference ' +
      'only fully-qualified domain names," appears once, so it needs no ' +
      'lengthening (contrast R-5321-2.4-q). The comma is load-bearing for that ' +
      'uniqueness — do not trim it. ' +
      'Trap: this is about the HEADER section, not the envelope. A test author ' +
      'scanning for "fully-qualified" will find several 5321 requirements that ' +
      'look alike and are about entirely different parts of the message; this one ' +
      'is not the one you can assert with a RCPT command.',
  },
  {
    id: 'R-5321-3.7.4-d',
    section: '3.7.4',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'and MUST be effective and useful for sending replies.',
    testability: {
      kind: 'not-testable',
      reason:
        'Neither "effective" nor "useful for sending replies" has a wire ' +
        'observable, and both depend on the state of a foreign mail environment. ' +
        'Untestable on its face, not merely out of our reach.',
    },
    note:
      'Arguably the least mechanisable MUST in RFC 5321: it demands that an ' +
      'address WORK, which is a fact about a system we are not talking to and ' +
      'cannot be settled by any exchange. Registered because deleting the ' +
      'inconvenient MUSTs is how denominators start lying.',
  },
  {
    id: 'R-5321-3.7.4-e',
    section: '3.7.4',
    page: 29,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The translation algorithm used to convert mail from the Internet ' +
      'protocols to another environment\'s protocol SHOULD ensure that error ' +
      'messages from the foreign mail environment are delivered to the ' +
      'reverse-path from the SMTP envelope, not to an address in the "From:", ' +
      '"Sender:", or similar header fields of the message.',
    testability: {
      kind: 'not-testable',
      reason:
        'About where a foreign environment\'s bounces end up — an asynchronous ' +
        'outcome in a system we have no connection to, arriving (if at all) long ' +
        'after our session has closed.',
    },
    note:
      'This is the envelope-vs-header bounce-routing rule, the same principle ' +
      'that §3.6.3 and §4.4 lean on. Real and frequently violated in the wild, ' +
      'and completely invisible to an SMTP client. If a future task ever gains a ' +
      'bounce-receiving mailbox, revisit — this and R-5321-3.7.5-a would become ' +
      'reachable together, and they are the pair worth reaching for.',
  },
  {
    id: 'R-5321-3.7.5-a',
    section: '3.7.5',
    page: 30,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Similarly, when forwarding a message from another environment into the ' +
      'Internet, the gateway SHOULD set the envelope return path in accordance ' +
      'with an error message return address, if supplied by the foreign ' +
      'environment.',
    testability: {
      kind: 'not-testable',
      reason:
        'The gateway sets this reverse-path on a MAIL command it issues as a ' +
        'client to some downstream server. We are never that downstream server; ' +
        'observing it would require being on the Internet side of the gateway ' +
        'with a message arriving from the foreign side.',
    },
    note:
      'Quoted from "Similarly" — the word is part of the sentence and its ' +
      'presence is why this section is short: §3.7.5 is the mirror of ' +
      'R-5321-3.7.4-e (Internet -> foreign) pointed the other way ' +
      '(foreign -> Internet). Together they say bounces follow the envelope in ' +
      'both directions. Do not register them as one requirement: they bind ' +
      'different directions of traversal and a gateway can get one right and the ' +
      'other wrong.',
  },
  {
    id: 'R-5321-3.7.5-b',
    section: '3.7.5',
    page: 30,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If the foreign environment has no equivalent concept, the gateway must ' +
      'select and use a best approximation, with the message originator\'s ' +
      'address as the default of last resort.',
    testability: {
      kind: 'not-testable',
      reason:
        'Same blindness as R-5321-3.7.5-a: concerns the reverse-path the gateway ' +
        'chooses when emitting into the Internet. Compounded by "best ' +
        'approximation", which admits no objective check even with full ' +
        'visibility.',
    },
    note:
      'LOWERCASE "must", hence `prose` rather than `keyword`. This matters and is ' +
      'easy to get wrong: RFC 2119 keywords are the capitalised forms, so a ' +
      'grep for "MUST" misses this sentence entirely and an extractor working ' +
      'from a keyword scan would drop it. The force is plainly obligatory — ' +
      '"must select and use" — so it is registered at MUST level with the source ' +
      'marked honestly. Whether the RFC editors intended a normative MUST or ' +
      'merely prose emphasis is genuinely unclear, and 5321bis is the place to ' +
      'look; flagged here rather than resolved. ' +
      'Note the fallback is only "the default of last resort", so a gateway ' +
      'choosing something better is complying, not deviating — a test asserting ' +
      'the originator address specifically would be wrong even with visibility.',
  },
] as const satisfies readonly RequirementDef[];
