/**
 * RFC 5321 §1.1–1.3 — Introduction
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * Section 1 is almost entirely narrative — objectives, document history, and
 * the RFC 2119 boilerplate. Nothing here binds an on-the-wire behaviour, so
 * every entry below is `not-testable` by construction. They are registered
 * anyway: §1.3 in particular sets the interpretive rules that the rest of the
 * register is scored against, and dropping the section would silently shrink
 * the denominator.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S1 = [
  {
    id: 'R-5321-1.1-a',
    section: '1.1',
    page: 5,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'SMTP is independent of the particular transmission subsystem and ' +
      'requires only a reliable ordered data stream channel.',
    testability: {
      kind: 'not-testable',
      reason:
        'A layering constraint on the protocol itself, not a behaviour either ' +
        'party performs. We reach the server over exactly one transport (TCP), ' +
        'so we can never observe whether an implementation depends on anything ' +
        'beyond a reliable ordered stream.',
    },
    note:
      'The weakest `prose` entry in this section, and flagged as such ' +
      'deliberately. The reading is: "requires only" caps what an SMTP ' +
      'implementation is permitted to demand of the layer below it, so a ' +
      'server needing out-of-band signalling, record boundaries, or ' +
      'seek/rewind would be non-conforming. That has the force of a MUST, but ' +
      'the sentence is written as description, and a reasonable extractor ' +
      'could call it narrative and drop it. Registered rather than dropped ' +
      'because the honest failure mode here is omission, not over-count — the ' +
      'entry costs one not-testable row and documents the judgement. ' +
      'The neighbouring sentences ("The objective of the Simple Mail Transfer ' +
      'Protocol (SMTP) is to transfer mail reliably and efficiently", the ' +
      'definition of "network", and "The Mail eXchanger mechanisms ... are ' +
      'used to identify the appropriate next-hop destination") are pure ' +
      'narrative and are NOT registered; the MX obligations they gesture at ' +
      'live in §5 and belong to whoever extracts it.',
  },
  {
    id: 'R-5321-1.2-a',
    section: '1.2',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Where this specification moves beyond consolidation and actually ' +
      'differs from earlier documents, it supersedes them technically as well ' +
      'as textually.',
    testability: {
      kind: 'not-testable',
      reason:
        'A precedence rule about which document wins when 5321 and its ' +
        'predecessors conflict. It governs how the specification is READ, not ' +
        'anything a client or server does. Same family as R-5321-2.4-o: there ' +
        'is no wire event corresponding to superseding a document.',
    },
    note:
      'Registered because it is genuinely normative despite the missing ' +
      'keyword — it is the conflict-resolution clause for the whole document, ' +
      'and it is what makes the register\'s baseline defensible: where 5321 ' +
      'differs from RFC 821 / 974 / 1869 / 2821 / 1123, this sentence says we ' +
      'score against 5321 and nothing else. Read it against the earlier ' +
      'promise that the document "consolidates, updates and clarifies, but ' +
      'does not add new or change existing functionality" — §1.2 makes that ' +
      'claim and then, here, concedes it is not quite true. The concession is ' +
      'the normative half. ' +
      'Trap for anyone tempted to make this testable: a server that follows ' +
      'RFC 821 where 821 and 5321 disagree fails the SPECIFIC 5321 ' +
      'requirement it violates, and should be reported against that ' +
      'requirement — never against this one.',
  },
  {
    id: 'R-5321-1.2-b',
    section: '1.2',
    page: 6,
    level: 'RECOMMENDED',
    party: 'client',
    normativeSource: 'prose',
    text:
      'In general, the separate mail submission protocol specified in RFC 4409 ' +
      '[18] is now preferred to direct use of SMTP;',
    testability: {
      kind: 'not-testable',
      reason:
        'An architectural preference addressed to deployers and message ' +
        'submission agents about which protocol to choose. The choice is made ' +
        'before a connection exists, so nothing on the wire distinguishes a ' +
        'client that weighed it from one that never read it.',
    },
    note:
      '"is now preferred" carries RECOMMENDED force without the keyword, hence ' +
      '`prose` — but hedged twice ("In general", plus the pointer to RFC 4409 ' +
      'for the real discussion), so the force is weak. Registered for ' +
      'completeness rather than value. ' +
      'Quoted with the trailing semicolon to keep the clause bounded; the ' +
      'remainder ("more discussion of that subject appears in that document") ' +
      'is a cross-reference, not a requirement. ' +
      'Note RFC 4409 is obsoleted by RFC 6409 — 5321 cites the old number and ' +
      'we quote it as printed, exactly as with the RFC 1652/6152 case in ' +
      'R-5321-2.4-n. Scope note: this is about SUBMISSION (port 587), which ' +
      'this suite may target, but 4409/6409 conformance is not RFC 5321 ' +
      'conformance and must not be scored here.',
  },
  {
    id: 'R-5321-1.3-a',
    section: '1.3',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", ' +
      '"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this ' +
      'document are to be interpreted as described in RFC 2119 [5].',
    testability: {
      kind: 'not-testable',
      reason:
        'The RFC 2119 boilerplate. It fixes the meaning of the vocabulary the ' +
        'other requirements are written in; it is not itself a behaviour and ' +
        'has no wire event.',
    },
    note:
      '`prose`, not `keyword`: the keywords appear here as quoted vocabulary ' +
      'being defined, not as a keyword being used. This entry is the licence ' +
      'for the whole `level` field — `Level` in types.ts is RFC 2119 because ' +
      'this sentence says so. ' +
      'Extraction trap worth recording: 5321 imports all ten terms, including ' +
      'SHALL, SHALL NOT and OPTIONAL, which `Level` in types.ts does not ' +
      'model. That is not an omission — a case-sensitive grep of the whole RFC ' +
      'finds SHALL, SHALL NOT and OPTIONAL nowhere except inside this ' +
      'sentence: the document imports three terms it then never uses. The ' +
      '17 hits for "optional" are all lowercase and all ordinary English ' +
      '("The optional <mail-parameters>", "optional modes of message ' +
      'handling"), which do NOT carry 2119 force and must not be extracted as ' +
      'MAY rows — that is the live hazard for §3.x and §4.1.1 extractors, not ' +
      'the missing enum members. If a later section does turn up a genuine ' +
      'uppercase use, `Level` needs widening; do not silently coerce it.',
  },
  {
    id: 'R-5321-1.3-b',
    section: '1.3',
    page: 6,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'As each of these terms was intentionally and carefully chosen to ' +
      'improve the interoperability of email, each use of these terms is to be ' +
      'treated as a conformance requirement.',
    testability: {
      kind: 'not-testable',
      reason:
        'A meta-rule about how the other requirements are to be weighted. It ' +
        'binds the reader of the specification, not a client or a server, so ' +
        'there is nothing to assert over a socket.',
    },
    note:
      'The single most consequential sentence in Section 1 for this project, ' +
      'and the reason §1 is extracted at all rather than waved through as ' +
      'narrative. 5321 goes beyond plain RFC 2119: it declares that EVERY ' +
      'keyword use — not just the MUSTs — is a conformance requirement. That ' +
      'is what justifies the register carrying SHOULD and MAY rows at all, ' +
      'and what justifies the report naming which side of a MAY a server took ' +
      '(the `permitted-latitude` outcome, task #9). Under a bare 2119 reading ' +
      'those rows would be decoration. ' +
      'The trap, and it is a big one: this sentence does NOT promote SHOULD to ' +
      'MUST. "Treated as a conformance requirement" means the choice is ' +
      'in scope and must be reported, not that departing from a SHOULD is a ' +
      'failure — RFC 2119 §3 still permits it with good reason, and §1.3 ' +
      'says nothing to override that. A test author who reads this sentence ' +
      'as "SHOULD means MUST in 5321" will fail conforming servers en masse ' +
      '(R-5321-2.4-l and R-5321-2.4-n are the nearest landmines). SHOULD ' +
      'violations are `permitted-latitude`, reported and not failed.',
  },
  {
    id: 'R-5321-1.3-c',
    section: '1.3',
    page: 6,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'prose',
    text:
      'Readers are cautioned that these are illustrative examples that should ' +
      'not actually be used in either code or configuration files.',
    testability: {
      kind: 'not-testable',
      reason:
        'Addressed to readers of the document about what to put in their own ' +
        'source and configuration. It constrains an implementation\'s build ' +
        'artefacts, not its protocol behaviour, and nothing on the wire ' +
        'reveals where a hostname in a config file was copied from.',
    },
    note:
      '`prose` because the "should not" is lowercase and therefore outside the ' +
      'RFC 2119 vocabulary §1.3-a just imported — but it is a real caution ' +
      'with SHOULD NOT force, so it is registered at that level rather than ' +
      'dropped. The examples it means are the RFC 2821 holdovers, ' +
      'principally the "isi.edu" / "bbn-unix.arpa" style names and the ' +
      'domains in the §4.3.2 and Appendix D scenarios. ' +
      'Text spans the page 6/7 boundary in spec/rfc5321.txt; quoted ' +
      'continuously and filed under page 6, where it starts. ' +
      'This binds US as much as any implementation under test: the suite\'s ' +
      'own corpus (task #12) must not reuse the RFC\'s example domains. Use ' +
      'example.com / example.net / example.org per RFC 2606 instead — several ' +
      'of the names 5321 prints are real, resolvable hosts, and pointing a ' +
      'conformance run at one would be somebody else\'s incident.',
  },
] as const satisfies readonly RequirementDef[];
