/**
 * RFC 5321 §3.6 — Relaying and Mail Routing
 * (§3.6.1 Source Routes and Relaying, §3.6.2 Mail eXchange Records and
 * Relaying, §3.6.3 Message Submission Servers as Relays)
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Section-wide context for whoever writes these tests: this is the least
 * wire-observable stretch of the RFC so far. Relaying is by definition about
 * what a server does on its NEXT hop, and this suite only ever sees the hop it
 * dialled. Of the entries below, exactly two (`R-5321-3.6.1-b`,
 * `R-5321-3.6.2-c`) produce a reply code we can look at; the rest describe
 * queueing, bounce generation, and content inspection that leave no trace on
 * the submitting connection. That is not a gap in the extraction — it is the
 * shape of the section, and shrinking it by deleting the invisible half would
 * be exactly the dishonesty the register exists to prevent.
 *
 * §3.6 itself is a bare heading (line 1419) with no body text; all entries
 * below belong to its subsections.
 *
 * RFC 5321 §1.3 restricts conformance keywords to the UPPERCASE forms and says
 * "each use of these terms is to be treated as a conformance requirement".
 * This section contains a lowercase "may" (§3.6.2) and a lowercase "must"
 * (§3.6.3) which are therefore NOT keywords; both are registered as `prose`
 * with the reading spelled out.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S3_6 = [
  // -- §3.6.1  Source Routes and Relaying -----------------------------------
  {
    id: 'R-5321-3.6.1-a',
    section: '3.6.1',
    page: 26,
    level: 'SHOULD NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP clients SHOULD NOT generate explicit source routes except under ' +
      'unusual circumstances.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. Our own client must take the SHOULD NOT in normal ' +
        'operation but must be able to break it deliberately, since generating ' +
        'a source route is the only way to probe R-5321-3.6.1-b and -c.',
    },
    note:
      'The "except under unusual circumstances" escape is doing real work for ' +
      'us: a conformance prober IS an unusual circumstance, so our corpus does ' +
      'not violate this requirement when it emits a source-routed RCPT.',
  },
  {
    id: 'R-5321-3.6.1-b',
    section: '3.6.1',
    page: 26,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'SMTP servers MAY decline to act as mail relays or to accept addresses ' +
      'that specify source routes.',
    testability: { kind: 'wire' },
    note:
      'The one cheaply observable requirement in §3.6.1: send ' +
      'RCPT TO:<@relay.example:user@final.example> and watch the code. It is a ' +
      'MAY with both branches named, so NEITHER acceptance nor rejection can ' +
      'be a failure — expect `permitted-latitude` and record which way the ' +
      'server went, because in 2026 practically every server declines and the ' +
      'rare one that does not is interesting. ' +
      'Trap: do not assert a specific rejection code. The RFC attaches no code ' +
      'to this permission at all (the 550 in §3.6.2 is about policy refusal to ' +
      'relay, a different thing), and real servers answer 501, 550, 553 and ' +
      '554 here. Assert only that the reply is a valid 5yz if rejected. ' +
      'Second trap: the two limbs are separable. A server may decline source ' +
      'routes while happily relaying, or relay while refusing routes. Record ' +
      'the answer to the question you actually asked.',
  },
  {
    id: 'R-5321-3.6.1-c',
    section: '3.6.1',
    page: 26,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'When route information is encountered, SMTP servers MAY ignore the ' +
      'route information and simply send to the final destination specified as ' +
      'the last element in the route',
    testability: {
      kind: 'not-testable',
      reason:
        'Whether an accepted source route was ignored or honoured is a ' +
        'next-hop decision. From the submitting socket, "ignored the route and ' +
        'sent to the last element" and "honoured the route" produce the same ' +
        '250. Would need a listener on the route hop plus a delivery sink — a ' +
        'different tool, as with R-5321-2.4-d.',
    },
    note:
      'Split from R-5321-3.6.1-d, which is the SHOULD half of the same ' +
      'sentence. Kept separate because `level` is the field that records the ' +
      'difference and the sentence genuinely carries two: a permission and, ' +
      'immediately after, a recommendation to exercise it. ' +
      'Quote deliberately stops before "and SHOULD do so." so the two entries ' +
      'do not duplicate each other\'s force.',
  },
  {
    id: 'R-5321-3.6.1-d',
    section: '3.6.1',
    page: 26,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'simply send to the final destination specified as the last element in ' +
      'the route and SHOULD do so.',
    testability: {
      kind: 'not-testable',
      reason:
        'Same next-hop invisibility as R-5321-3.6.1-c: the recommendation is ' +
        'about where the mail goes after we hang up.',
    },
    note:
      'Quoted with the leading "simply send to the final destination..." ' +
      'clause rather than the bare "and SHOULD do so." — the short form is far ' +
      'too generic to be a safely unique substring of the RFC, the same ' +
      'reasoning as R-5321-2.4-q. ' +
      'Worth noticing the drafting: a server that takes R-5321-3.6.1-b\'s ' +
      'permission to decline source routes never reaches this SHOULD, so the ' +
      'common posture (reject outright) is fully conformant and this entry is ' +
      'vacuous for it. Do not report a rejecting server as failing to meet a ' +
      'SHOULD it was never subject to.',
  },
  {
    id: 'R-5321-3.6.1-e',
    section: '3.6.1',
    page: 26,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'This is one of several reasons why SMTP clients MUST NOT generate ' +
      'invalid source routes or depend on serial resolution of names.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client, and the second limb ("depend on serial resolution ' +
        'of names") is about the client\'s internal resolution strategy, which ' +
        'has no wire representation even in principle.',
    },
    note:
      'Two obligations in one sentence — generating invalid source routes, and ' +
      'depending on serial name resolution — but they bind the same party and ' +
      'are equally unobservable, so they are not split. ' +
      'Note the tension with R-5321-3.6.1-a: a client may generate source ' +
      'routes under unusual circumstances (SHOULD NOT), but may never generate ' +
      'INVALID ones (MUST NOT). Our corpus lives in that gap and must stay ' +
      'there: probe with well-formed routes only.',
  },
  {
    id: 'R-5321-3.6.1-f',
    section: '3.6.1',
    page: 26,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'When source routes are not used, the process described in RFC 821 for ' +
      'constructing a reverse-path from the forward-path is not applicable and ' +
      'the reverse-path at the time of delivery will simply be the address ' +
      'that appeared in the MAIL command.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns the reverse-path "at the time of delivery" — i.e. what the ' +
        'next hop or the mailbox sees, not what we sent. Unobservable from the ' +
        'submitting socket by construction.',
    },
    note:
      'A borderline `prose` call, and I want to be explicit about the reading ' +
      'rather than smuggle it in. The sentence is written as consequence, not ' +
      'obligation, and most of it is scoping: it disapplies an RFC 821 ' +
      'procedure. But the final clause — "the reverse-path at the time of ' +
      'delivery will simply be the address that appeared in the MAIL command" ' +
      '— states an outcome that a system could fail to produce, which gives it ' +
      'the force of a MUST NOT on rewriting the reverse-path in transit. ' +
      'Registered on that basis. A reader who thinks this is pure exposition ' +
      'is not being unreasonable; it is registered rather than dropped because ' +
      'an over-inclusive denominator is the cheaper mistake.',
  },

  // -- §3.6.2  Mail eXchange Records and Relaying ---------------------------
  {
    id: 'R-5321-3.6.2-a',
    section: '3.6.2',
    page: 26,
    level: 'MAY',
    party: 'server',
    normativeSource: 'prose',
    text:
      'The relay server may accept or reject the task of relaying the mail in ' +
      'the same way it accepts or rejects mail for a local user.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient domain the server under test does not relay for, and — to ' +
        'make the comparison the sentence actually draws — a local recipient ' +
        'it does accept, so "the same way" has something to be the same as.',
    },
    note:
      'Lowercase "may", so NOT an RFC 2119 keyword under §1.3, which scopes ' +
      'conformance to the uppercase forms. Registered as `prose` at MAY level ' +
      'because it plainly grants latitude and is the premise the SHOULD in ' +
      'R-5321-3.6.2-c hangs off — "if it declines" only makes sense because ' +
      'this sentence says it may. ' +
      'The testable content is thinner than it looks. "In the same way" is ' +
      'about the timing and shape of the decision (at RCPT, with a reply ' +
      'code), not about the code matching. Do not write a test asserting that ' +
      'relay refusal and unknown-local-user refusal return the SAME code — ' +
      'they routinely differ (550 5.7.1 vs 550 5.1.1) and that is correct.',
  },
  {
    id: 'R-5321-3.6.2-b',
    section: '3.6.2',
    page: 26,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'If it accepts the task, it then becomes an SMTP client, establishes a ' +
      'transmission channel to the next SMTP server specified in the DNS ' +
      '(according to the rules in Section 5), and sends it the mail.',
    testability: {
      kind: 'not-testable',
      reason:
        'Everything it describes happens after our connection closes: ' +
        'becoming a client, MX resolution, and the onward channel. Verifying ' +
        'it needs an instrumented next hop, not a socket.',
    },
    note:
      '`prose`, and a soft one — the sentence is written descriptively. It is ' +
      'registered because it is where 5321 pins the meaning of "accepted the ' +
      'task": a server that returns 250 to RCPT has committed to onward ' +
      'delivery per Section 5, and the MUST in R-5321-3.6.3-a (bounce on ' +
      'failure) is only coherent if this sentence binds. Read as: acceptance ' +
      'is a promise, not an opinion. ' +
      'The normative weight really lives in the Section 5 cross-reference; ' +
      'whoever extracts §5 should check this entry does not duplicate one of ' +
      'theirs.',
  },
  {
    id: 'R-5321-3.6.2-c',
    section: '3.6.2',
    page: 26,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If it declines to relay mail to a particular address for policy ' +
      'reasons, a 550 response SHOULD be returned.',
    testability: {
      kind: 'wire-with-fixture',
      fixture:
        'A recipient domain the server under test is known NOT to relay for ' +
        '(e.g. RCPT TO:<probe@example.net> against a server authoritative only ' +
        'for example.com), with the refusal known to be policy-driven rather ' +
        'than a syntax or resource failure.',
    },
    note:
      'The highest-value entry in this section and the easiest one to get ' +
      'wrong. Traps, in order of how likely they are to bite: ' +
      '(1) The sentence spans the page 26/27 break in spec/rfc5321.txt — it ' +
      'starts at "If it declines to" on page 26 and finishes after the ' +
      'furniture. Quoted continuously; page 26 per the "takes the page it ' +
      'starts on" rule. ' +
      '(2) It is a SHOULD, so 554 (very common for relay refusal) and 553 are ' +
      '`permitted-latitude`, NOT failures. A test that demands exactly 550 ' +
      'will fail large numbers of correct servers. Assert 5yz; record the ' +
      'actual code as an observation. ' +
      '(3) "for policy reasons" is a real precondition we cannot verify from ' +
      'outside. A 450 or 451 here may mean a temporary resource problem rather ' +
      'than a policy decline, in which case this requirement never engaged. ' +
      'The fixture must isolate policy refusal or the test is measuring noise. ' +
      '(4) Some servers defer relay refusal to DATA-dot rather than RCPT. That ' +
      'is a §3.3 question, not this one; do not conflate a late 550 with a ' +
      'missing one.',
  },
  {
    id: 'R-5321-3.6.2-d',
    section: '3.6.2',
    page: 27,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'A server MAY attempt to verify the return path before using its address ' +
      'for delivery notifications, but methods of doing so are not defined ' +
      'here nor is any particular method recommended at this time.',
    testability: {
      kind: 'not-testable',
      reason:
        'The permission is scoped to verification performed "before using its ' +
        'address for delivery notifications" — i.e. at bounce time, after our ' +
        'connection is gone. The RFC also declines to define any method, so ' +
        'there is no wire signature to look for even if we could see it.',
    },
    note:
      'The preceding sentence ("This specification does not deal with the ' +
      'verification of return paths...") is scoping, not a requirement, and is ' +
      'deliberately not registered. ' +
      'Trap worth writing down because it is genuinely tempting: this entry is ' +
      'NOT about SPF rejection at MAIL FROM. Servers do reject on SPF and it ' +
      'is very visible, but that is a different act (refusing inbound mail) ' +
      'from the one permitted here (checking a return path before addressing a ' +
      'DSN to it). The SPF [29] and DKIM [30] [31] citations invite exactly ' +
      'this confusion. Do not write an SPF test against this ID.',
  },

  // -- §3.6.3  Message Submission Servers as Relays -------------------------
  //
  // The first three paragraphs (lines 1477-1492) are exposition: they describe
  // POP3/IMAP-adjacent submission clients, note that private submission
  // arrangements "fall outside the scope of this specification", point at
  // RFC 4409 [18], and observe that MX records can designate gateways. Nothing
  // in them binds either party and nothing is registered from them. Read in
  // full; this is a positive statement of absence, not a skip.
  {
    id: 'R-5321-3.6.3-a',
    section: '3.6.3',
    page: 27,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'If an SMTP server has accepted the task of relaying the mail and later ' +
      'finds that the destination is incorrect or that the mail cannot be ' +
      'delivered for some other reason, then it MUST construct an ' +
      '"undeliverable mail" notification message and send it to the ' +
      'originator of the undeliverable mail (as indicated by the reverse-path).',
    testability: {
      kind: 'not-testable',
      reason:
        'The obligation is discharged by a message the server SENDS to us ' +
        'later, over a connection it initiates. Observing it needs an inbound ' +
        'MX sink for the reverse-path domain and a wait of minutes to days — ' +
        'the same "different tool" boundary as R-5321-2.4-d. Revisit if ' +
        'task #12 grows an inbound sink.',
    },
    note:
      'This is the section\'s only MUST on a receiver and we cannot see it. ' +
      'Worth stating plainly rather than dressing up as wire-with-fixture: a ' +
      'fixture is server-side STATE we arrange, whereas this needs a whole ' +
      'second protocol role (us as receiver) and an asynchronous window. ' +
      'Calling it wire-with-fixture would be over-claiming. ' +
      '"reverse-path" is hyphenated across a line break in the source; quoted ' +
      'rejoined, as the normaliser expects. ' +
      'Note the precondition chain: this MUST only engages for a server that ' +
      'ACCEPTED the relay task (R-5321-3.6.2-b). A server that rejects at RCPT ' +
      'has no bounce obligation at all — which is precisely why rejecting ' +
      'early is the modern best practice and why backscatter is a violation of ' +
      'nothing in 5321 by servers that never accepted.',
  },
  {
    id: 'R-5321-3.6.3-b',
    section: '3.6.3',
    page: 27,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Formats specified for non-delivery reports by other standards (see, for ' +
      'example, RFC 3461 [32] and RFC 3464 [33]) SHOULD be used if possible.',
    testability: {
      kind: 'not-testable',
      reason:
        'Concerns the FORMAT of a bounce message we never receive. Doubly out ' +
        'of reach: needs the inbound sink of R-5321-3.6.3-a, and then needs ' +
        'MIME parsing of the DSN body rather than any SMTP-level assertion.',
    },
    note:
      'Quoted with the "(see, for example, RFC 3461 [32] and RFC 3464 [33])" ' +
      'parenthetical and its reference markers intact, per the quoting rules. ' +
      'The "if possible" hedge on top of a SHOULD leaves almost nothing to ' +
      'fail even with a sink in hand.',
  },
  {
    id: 'R-5321-3.6.3-c',
    section: '3.6.3',
    page: 27,
    level: 'MUST',
    party: 'server',
    normativeSource: 'prose',
    text:
      'This notification message must be from the SMTP server at the relay ' +
      'host or the host that first determines that delivery cannot be ' +
      'accomplished.',
    testability: {
      kind: 'not-testable',
      reason:
        'Identifies which host must originate a bounce we cannot receive. ' +
        'Needs the inbound sink of R-5321-3.6.3-a, and then needs us to know ' +
        'the relay topology well enough to say whether the originating host ' +
        'was the right one.',
    },
    note:
      'Lowercase "must", so `prose` under §1.3, which confines conformance to ' +
      'the uppercase forms. The force is unambiguous — it is an obligation ' +
      'about origination, sitting between two genuine uppercase requirements — ' +
      'and I read the lowercase as an editing slip rather than deliberate ' +
      'softening. Registered at MUST level on that reading, flagged here ' +
      'because it is exactly the kind of judgement a reader is entitled to ' +
      'disagree with. Plausible bis fodder.',
  },
  {
    id: 'R-5321-3.6.3-d',
    section: '3.6.3',
    page: 27,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'Of course, SMTP servers MUST NOT send notification messages about ' +
      'problems transporting notification messages.',
    testability: {
      kind: 'not-testable',
      reason:
        'Proving a negative about a message that would arrive out of band. ' +
        'Needs the inbound sink of R-5321-3.6.3-a plus an unbounded wait to ' +
        'assert that no bounce-of-a-bounce ever arrived.',
    },
    note:
      'The anti-loop rule, and the whole reason null reverse-paths exist. ' +
      'Superficially this looks like the one bounce requirement we could probe ' +
      'in-band — accept from <> to a doomed recipient, see if anything comes ' +
      'back — but "nothing arrived" is unfalsifiable on a timer, and the ' +
      'server may legitimately be queueing. ' +
      'The sentence that follows in the RFC ("One way to prevent loops in ' +
      'error reporting is to specify a null reverse-path...") is advisory ' +
      'illustration — "one way" — and is not registered.',
  },
  {
    id: 'R-5321-3.6.3-e',
    section: '3.6.3',
    page: 27,
    level: 'MUST',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'When such a message is transmitted, the reverse-path MUST be set to ' +
      'null (see Section 4.5.5 for additional discussion).',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds whoever transmits the notification. When the server under test ' +
        'bounces, it takes the client role on a connection to someone else, so ' +
        'the MAIL FROM we would need to inspect is never sent to us.',
    },
    note:
      'party is `client` deliberately, and it is a slightly uncomfortable ' +
      'call: the ACTOR is a server, but the ROLE it holds while transmitting a ' +
      'bounce is the SMTP client role, which is what §3.6.2 means by "it then ' +
      'becomes an SMTP client". Classifying by role keeps `client` meaning ' +
      '"the sending end", which is what makes the party field predictive of ' +
      'testability at all. ' +
      'Trap: this is NOT the "server must accept MAIL FROM:<>" requirement. ' +
      'That obligation is in §4.5.5, is genuinely wire-testable, and belongs ' +
      'to whoever extracts that section. Do not attach a null-sender ' +
      'acceptance test to this ID. ' +
      'Text spans the page 27/28 boundary; quoted continuously and taking ' +
      'page 27, where it starts. The "MAIL FROM:<>" example that follows is ' +
      'illustration, not a requirement.',
  },
  {
    id: 'R-5321-3.6.3-f',
    section: '3.6.3',
    page: 28,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'As discussed in Section 6.4, a relay SMTP has no need to inspect or act ' +
      'upon the header section or body of the message data and MUST NOT do so ' +
      'except to add its own "Received:" header field (Section 4.4) and, ' +
      'optionally, to attempt to detect looping in the mail system (see ' +
      'Section 6.3).',
    testability: {
      kind: 'not-testable',
      reason:
        'Inspection leaves no trace anywhere — not on our socket, not in the ' +
        'delivered message, not on the next hop. Even with a full end-to-end ' +
        'path this requirement would be unobservable in its inspection limb.',
    },
    note:
      'Read this against R-5321-2.4-i, which says a relay "SHOULD assume that ' +
      'the message content it has received is valid and, assuming that the ' +
      'envelope permits doing so, relay it without inspecting that content". ' +
      'Same prohibition, escalated: SHOULD there, MUST NOT here. That is not a ' +
      'drafting accident worth papering over — §2.4 is hedged with "In ' +
      'general" and speaks of content validity, while this is the hard rule ' +
      'for the relay role specifically. If the two ever get merged in a ' +
      'coverage report, the escalation disappears. ' +
      'Note the requirement is honoured in the breach by essentially every ' +
      'deployed relay: content filtering, virus scanning and DKIM signing are ' +
      'all inspection of exactly the kind prohibited here. The RFC lost this ' +
      'argument to operational reality, and we cannot even see it happen. ' +
      'The two exceptions ("Received:", loop detection) are carve-outs from ' +
      'the prohibition, not separate permissions, so they stay in this entry.',
  },
  {
    id: 'R-5321-3.6.3-g',
    section: '3.6.3',
    page: 28,
    level: 'MUST NOT',
    // 'prose', not 'keyword': the MUST NOT force is inherited by reference ("this
    // prohibition also applies"), from the antecedent prohibition in this section
    // — there is no RFC 2119 keyword in this sentence itself. The level is correct;
    // the source of its normativity is the prose reference, which the
    // level-matches-keyword gate rightly excludes from its keyword check.
    normativeSource: 'prose',
    party: 'server',
    text:
      'Of course, this prohibition also applies to any modifications of these ' +
      'header fields or text (see also Section 7.9).',
    testability: {
      kind: 'not-testable',
      reason:
        'Modification of the header section or body is visible only in what ' +
        'the next hop receives. Needs an end-to-end path with a receiving ' +
        'sink, which is a different tool — see R-5321-2.4-d.',
    },
    note:
      'Split from R-5321-3.6.3-f rather than folded into it, because the two ' +
      'limbs have different testability in principle even though both land on ' +
      '`not-testable` today: inspection is unobservable FOREVER, whereas ' +
      'modification becomes observable the moment task #12 gives us a ' +
      'receiving sink. That distinction is worth preserving in the register ' +
      'so a future sink-enabled run knows which of the two to revisit. ' +
      'The level is carried from the sentence it extends ("this prohibition"), ' +
      'so the entry is `keyword` on the strength of R-5321-3.6.3-f\'s ' +
      'MUST NOT rather than containing one itself. ' +
      'Quoted with the "(see also Section 7.9)" parenthetical intact.',
  },
] as const satisfies readonly RequirementDef[];
