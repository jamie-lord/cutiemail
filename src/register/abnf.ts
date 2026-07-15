/**
 * RFC 5321 §4.1.2 (Command Argument Syntax) and §4.1.3 (Address Literals),
 * extracted as machine-readable ABNF productions.
 *
 * Why this exists, and why it is dangerous on its own: a conformance corpus for
 * SMTP addresses wants to generate boundary cases for the mailbox grammar, and
 * the grammar is the obvious seed. But RFC 5321 §2.4 warns in as many words that
 * the ABNF is *not comprehensive* — the running prose both forbids inputs the
 * grammar accepts and requires things the grammar cannot express. A generator
 * driven by `ABNF_RULES` alone will emit strings the specification rejects (a
 * 300-octet local-part, an underscore in a domain label) and will never probe
 * the constraints the prose adds. `GRAMMAR_CAVEAT` and `TEXT_CONSTRAINTS` below
 * exist so that consumers of this data cannot forget that.
 *
 * The `rule` fields are quoted verbatim from spec/rfc5321.txt (RFC 5321,
 * Klensin, October 2008, lines 2260-2441). ABNF comments (the `;` lines) are
 * kept because in this section they carry normative force — see the register
 * note in src/register/sections/s4-1-2.ts. Do not paraphrase or "tidy" a rule;
 * a previous extraction fabricated a quote and was caught.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

/** An ABNF production as printed in the RFC. */
export interface AbnfRule {
  /** Left-hand side, e.g. "Reverse-path". */
  readonly name: string;
  /**
   * The verbatim right-hand side as printed in spec/rfc5321.txt, including any
   * `;` comment lines, with the RFC's line wrapping preserved. Trimmed only of
   * the common leading indentation the RFC uses to lay out the two columns.
   */
  readonly rule: string;
  /** RFC 5321 section the production is printed in. */
  readonly section: '4.1.2' | '4.1.3';
}

/**
 * The productions of §4.1.2 and §4.1.3, in the order the RFC prints them.
 *
 * Terminals not defined here (ALPHA, DIGIT, SP, CR, LF, CRLF, DQUOTE, HEXDIG)
 * are the RFC 5234 core rules; `atext` is imported from RFC 5322 §3.2.3 and is
 * deliberately NOT reproduced — this data set is the §4.1.2/§4.1.3 grammar, not
 * a self-contained one. A validator that resolves `Atom = 1*atext` must reach
 * outside this array, which is itself a reminder that the grammar is not closed.
 */
export const ABNF_RULES = [
  // ---- §4.1.2 Command Argument Syntax ----
  {
    name: 'Reverse-path',
    rule: 'Path / "<>"',
    section: '4.1.2',
  },
  {
    name: 'Forward-path',
    rule: 'Path',
    section: '4.1.2',
  },
  {
    name: 'Path',
    rule: '"<" [ A-d-l ":" ] Mailbox ">"',
    section: '4.1.2',
  },
  {
    name: 'A-d-l',
    rule:
      'At-domain *( "," At-domain )\n' +
      '; Note that this form, the so-called "source\n' +
      '; route", MUST BE accepted, SHOULD NOT be\n' +
      '; generated, and SHOULD be ignored.',
    section: '4.1.2',
  },
  {
    name: 'At-domain',
    rule: '"@" Domain',
    section: '4.1.2',
  },
  {
    name: 'Mail-parameters',
    rule: 'esmtp-param *(SP esmtp-param)',
    section: '4.1.2',
  },
  {
    name: 'Rcpt-parameters',
    rule: 'esmtp-param *(SP esmtp-param)',
    section: '4.1.2',
  },
  {
    name: 'esmtp-param',
    rule: 'esmtp-keyword ["=" esmtp-value]',
    section: '4.1.2',
  },
  {
    name: 'esmtp-keyword',
    rule: '(ALPHA / DIGIT) *(ALPHA / DIGIT / "-")',
    section: '4.1.2',
  },
  {
    name: 'esmtp-value',
    rule:
      '1*(%d33-60 / %d62-126)\n' +
      '; any CHAR excluding "=", SP, and control\n' +
      '; characters.  If this string is an email address,\n' +
      '; i.e., a Mailbox, then the "xtext" syntax [32]\n' +
      '; SHOULD be used.',
    section: '4.1.2',
  },
  {
    name: 'Keyword',
    rule: 'Ldh-str',
    section: '4.1.2',
  },
  {
    name: 'Argument',
    rule: 'Atom',
    section: '4.1.2',
  },
  {
    name: 'Domain',
    rule: 'sub-domain *("." sub-domain)',
    section: '4.1.2',
  },
  {
    name: 'sub-domain',
    rule: 'Let-dig [Ldh-str]',
    section: '4.1.2',
  },
  {
    name: 'Let-dig',
    rule: 'ALPHA / DIGIT',
    section: '4.1.2',
  },
  {
    name: 'Ldh-str',
    rule: '*( ALPHA / DIGIT / "-" ) Let-dig',
    section: '4.1.2',
  },
  {
    name: 'address-literal',
    rule:
      '"[" ( IPv4-address-literal /\n' +
      'IPv6-address-literal /\n' +
      'General-address-literal ) "]"\n' +
      '; See Section 4.1.3',
    section: '4.1.2',
  },
  {
    name: 'Mailbox',
    rule: 'Local-part "@" ( Domain / address-literal )',
    section: '4.1.2',
  },
  {
    name: 'Local-part',
    rule:
      'Dot-string / Quoted-string\n' +
      '; MAY be case-sensitive',
    section: '4.1.2',
  },
  {
    name: 'Dot-string',
    rule: 'Atom *("."  Atom)',
    section: '4.1.2',
  },
  {
    name: 'Atom',
    rule: '1*atext',
    section: '4.1.2',
  },
  {
    name: 'Quoted-string',
    rule: 'DQUOTE *QcontentSMTP DQUOTE',
    section: '4.1.2',
  },
  {
    name: 'QcontentSMTP',
    rule: 'qtextSMTP / quoted-pairSMTP',
    section: '4.1.2',
  },
  {
    name: 'quoted-pairSMTP',
    rule:
      '%d92 %d32-126\n' +
      '; i.e., backslash followed by any ASCII\n' +
      '; graphic (including itself) or SPace',
    section: '4.1.2',
  },
  {
    name: 'qtextSMTP',
    rule:
      '%d32-33 / %d35-91 / %d93-126\n' +
      '; i.e., within a quoted string, any\n' +
      '; ASCII graphic or space is permitted\n' +
      '; without blackslash-quoting except\n' +
      '; double-quote and the backslash itself.',
    section: '4.1.2',
  },
  {
    name: 'String',
    rule: 'Atom / Quoted-string',
    section: '4.1.2',
  },

  // ---- §4.1.3 Address Literals ----
  {
    name: 'IPv4-address-literal',
    rule: 'Snum 3("."  Snum)',
    section: '4.1.3',
  },
  {
    name: 'IPv6-address-literal',
    rule: '"IPv6:" IPv6-addr',
    section: '4.1.3',
  },
  {
    name: 'General-address-literal',
    rule: 'Standardized-tag ":" 1*dcontent',
    section: '4.1.3',
  },
  {
    name: 'Standardized-tag',
    rule:
      'Ldh-str\n' +
      '; Standardized-tag MUST be specified in a\n' +
      '; Standards-Track RFC and registered with IANA',
    section: '4.1.3',
  },
  {
    name: 'dcontent',
    rule:
      '%d33-90 / ; Printable US-ASCII\n' +
      '%d94-126 ; excl. "[", "\\", "]"',
    section: '4.1.3',
  },
  {
    name: 'Snum',
    rule:
      '1*3DIGIT\n' +
      '; representing a decimal integer\n' +
      '; value in the range 0 through 255',
    section: '4.1.3',
  },
  {
    name: 'IPv6-addr',
    rule: 'IPv6-full / IPv6-comp / IPv6v4-full / IPv6v4-comp',
    section: '4.1.3',
  },
  {
    name: 'IPv6-hex',
    rule: '1*4HEXDIG',
    section: '4.1.3',
  },
  {
    name: 'IPv6-full',
    rule: 'IPv6-hex 7(":" IPv6-hex)',
    section: '4.1.3',
  },
  {
    name: 'IPv6-comp',
    rule:
      '[IPv6-hex *5(":" IPv6-hex)] "::"\n' +
      '[IPv6-hex *5(":" IPv6-hex)]\n' +
      '; The "::" represents at least 2 16-bit groups of\n' +
      '; zeros.  No more than 6 groups in addition to the\n' +
      '; "::" may be present.',
    section: '4.1.3',
  },
  {
    name: 'IPv6v4-full',
    rule: 'IPv6-hex 5(":" IPv6-hex) ":" IPv4-address-literal',
    section: '4.1.3',
  },
  {
    name: 'IPv6v4-comp',
    rule:
      '[IPv6-hex *3(":" IPv6-hex)] "::"\n' +
      '[IPv6-hex *3(":" IPv6-hex) ":"]\n' +
      'IPv4-address-literal\n' +
      '; The "::" represents at least 2 16-bit groups of\n' +
      '; zeros.  No more than 4 groups in addition to the\n' +
      '; "::" and IPv4-address-literal may be present.',
    section: '4.1.3',
  },
] as const satisfies readonly AbnfRule[];

/** Every production name in `ABNF_RULES`, as a union. */
export type AbnfRuleName = (typeof ABNF_RULES)[number]['name'];

/**
 * The productions a conformance corpus most wants to fuzz, with the boundary
 * cases each one hides. `production` is checked at compile time against the real
 * rule names, so a renamed rule breaks this list rather than silently orphaning
 * it.
 */
export interface ProductionOfInterest {
  readonly production: AbnfRuleName;
  /** The boundary / edge cases worth generating for this production. */
  readonly boundaryNote: string;
}

export const PRODUCTIONS_OF_INTEREST = [
  {
    production: 'Local-part',
    boundaryNote:
      'Dot-string vs Quoted-string branch; the 64-octet cap (§4.5.3.1.1) the ' +
      'ABNF omits; case-sensitivity (§2.4); leading/trailing/double dots in ' +
      'the Dot-string form; the empty local-part (grammar forbids it, some ' +
      'servers accept it).',
  },
  {
    production: 'Domain',
    boundaryNote:
      'Total length 255-octet cap and per-label 63 limit (§4.5.3.1.2 / DNS) ' +
      'the ABNF omits; leading digit in a label (allowed by Let-dig, was once ' +
      'contested); trailing/leading hyphen (Ldh-str forbids); underscore ' +
      '(grammar-legal as no char class, but §4.1.2 prose forbids); empty ' +
      'label / trailing dot; single-label vs FQDN.',
  },
  {
    production: 'Mailbox',
    boundaryNote:
      'The Domain vs address-literal branch after "@"; exactly one "@" at the ' +
      'top level vs "@" inside a Quoted-string local-part; the combined ' +
      'path-length cap (§4.5.3.1.3) that binds Mailbox indirectly.',
  },
  {
    production: 'Quoted-string',
    boundaryNote:
      'Embedded spaces and specials (@, comma, dot) that are illegal unquoted; ' +
      'quoted-pair backslash escaping (quoted-pairSMTP = \\ + any %d32-126); ' +
      'the empty quoted string ""; a bare backslash or bare DQUOTE (must be ' +
      'escaped); non-ASCII / control octets the prose bans regardless of quotes.',
  },
  {
    production: 'Dot-string',
    boundaryNote:
      'atext character set boundaries (which specials are legal unquoted); ' +
      'consecutive dots, leading dot, trailing dot — all rejected by the ' +
      '`Atom *("." Atom)` shape; a single Atom with no dots.',
  },
  {
    production: 'address-literal',
    boundaryNote:
      'IPv4 octet range (Snum 0-255 is a prose comment, not enforced by ' +
      '1*3DIGIT — "999" is grammar-legal); IPv6 "::" placement and group ' +
      'counts; the "IPv6:" tag prefix; General-address-literal with an ' +
      'unregistered tag; missing/extra brackets.',
  },
] as const satisfies readonly ProductionOfInterest[];

/**
 * RFC 5321 §2.4, verbatim (spec/rfc5321.txt lines 936-939). The single most
 * important sentence for anyone building a generator off this grammar: the ABNF
 * is necessary but not sufficient.
 */
export const GRAMMAR_CAVEAT =
  'The reader is cautioned that the grammar expressed in the ' +
  'metalanguage is not comprehensive.  There are many instances in which ' +
  'provisions in the text constrain or otherwise modify the syntax or ' +
  'semantics implied by the grammar.';

/**
 * A constraint imposed by RFC 5321 running prose that the §4.1.2/§4.1.3 ABNF
 * does NOT express. Each direction of failure matters:
 *
 * - `adds` — the prose *forbids* something the grammar accepts. A generator
 *   seeded only by the ABNF will emit it and wrongly treat a conforming
 *   rejection as a bug.
 * - `requires` — the prose *demands* something the grammar cannot state (a
 *   length bound, a resolution, a semantic equivalence). A generator seeded
 *   only by the ABNF will never probe it.
 */
export interface TextConstraint {
  /** RFC 5321 section carrying the prose. */
  readonly section: string;
  readonly page: number;
  /** Which production(s) in ABNF_RULES the constraint binds. */
  readonly binds: readonly AbnfRuleName[];
  /** Does the prose forbid a grammar-legal input, or add an unstateable demand? */
  readonly kind: 'adds' | 'requires';
  /** The constraint, quoted verbatim from spec/rfc5321.txt. */
  readonly text: string;
  /** Why the ABNF cannot capture it, and what a corpus should do about it. */
  readonly note: string;
}

export const TEXT_CONSTRAINTS = [
  {
    section: '4.5.3.1.1',
    page: 63,
    binds: ['Local-part'],
    kind: 'requires',
    text: 'The maximum total length of a user name or other local-part is 64\noctets.',
    note:
      'Local-part = Dot-string / Quoted-string has no length bound: the grammar ' +
      'accepts a 1000-octet local-part. A conforming server may reject at 65 ' +
      'octets. The corpus must generate the 64/65-octet boundary; the ABNF ' +
      'never will.',
  },
  {
    section: '4.5.3.1.2',
    page: 63,
    binds: ['Domain'],
    kind: 'requires',
    text: 'The maximum total length of a domain name or number is 255 octets.',
    note:
      'Domain = sub-domain *("." sub-domain) is unbounded in the grammar. The ' +
      '255-octet cap (and the DNS 63-octet-per-label limit the ABNF also omits) ' +
      'is a prose-only boundary.',
  },
  {
    section: '4.1.2',
    page: 42,
    binds: ['Domain', 'sub-domain', 'Ldh-str'],
    kind: 'adds',
    text:
      'characters outside the set of alphabetic characters, digits, and\n' +
      'hyphen MUST NOT appear in domain name labels for SMTP clients or\n' +
      'servers.  In particular, the underscore character is not permitted.',
    note:
      'Ldh-str already restricts sub-domain to letters, digits, and hyphen, so ' +
      'this is not a new character-class restriction — but the prose escalates ' +
      'it to a MUST NOT with a mandated 501 response, and it is the prose, not ' +
      'the grammar, that makes accepting "a_b.example.com" a conformance ' +
      'failure. The grammar and prose must be read together to know the verdict.',
  },
  {
    section: '2.4',
    page: 20,
    binds: ['Local-part'],
    kind: 'requires',
    text: 'The local-part of a mailbox MUST BE treated as case sensitive.',
    note:
      'The ABNF comment on Local-part says only "MAY be case-sensitive"; the ' +
      '§2.4 prose upgrades this to a MUST for receiver handling. Case is a ' +
      'semantic property no character-level grammar can express — "Smith" and ' +
      '"smith" parse identically yet must be treated as distinct mailboxes.',
  },
  {
    section: '4.1.2',
    page: 41,
    binds: ['Snum', 'IPv4-address-literal'],
    kind: 'adds',
    text:
      '; representing a decimal integer\n; value in the range 0 through 255',
    note:
      'Snum = 1*3DIGIT accepts "999" and "256"; only the ABNF comment restricts ' +
      'the value to 0-255. A generator that treats 1*3DIGIT as the whole truth ' +
      'will emit out-of-range IPv4 literals the specification forbids.',
  },
  {
    section: '4.1.2',
    page: 42,
    binds: ['Local-part', 'Mailbox'],
    kind: 'adds',
    text:
      'Systems MUST NOT define mailboxes in such a way as to require the use\n' +
      'in SMTP of non-ASCII characters (octets with the high order bit set\n' +
      'to one) or ASCII "control characters" (decimal value 0-31 and 127).\n' +
      'These characters MUST NOT be used in MAIL or RCPT commands or other\n' +
      'commands that require mailbox names.',
    note:
      'quoted-pairSMTP (%d92 %d32-126) and qtextSMTP already exclude control ' +
      'octets, but atext (imported from RFC 5322, not reproduced here) and the ' +
      'overall command framing do not, so the prose ban is the backstop that ' +
      'makes a high-bit or control octet in a mailbox a MUST NOT rather than a ' +
      'grammar question.',
  },
] as const satisfies readonly TextConstraint[];
