/**
 * RFC 5322 §3.6 — Field Definitions (occurrence rules)
 *
 * The heart of message VALIDATION: which header fields must be present, and which
 * may appear at most once. The authoritative source for the counts is the field
 * table (Figure 1); the required-fields rule and the singleton rule are also stated
 * in prose, which is what we quote. A validator built on our parser checks these.
 *
 * Verbatim quotes from spec/rfc5322.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const M_S3_6 = [
  {
    id: 'R-5322-3.6-a',
    rfc: 'rfc5322',
    section: '3.6',
    page: 19,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text:
      'The only required header fields are the origination date field and the ' +
      'originator address field(s)',
    testability: { kind: 'parse' },
    note:
      'PROSE MUST (the field table gives orig-date and from Min=1). A conformant ' +
      'message MUST carry a Date and a From; a validator flags either absent. Our ' +
      'generator MUST supply both on submission (submission fix-up, RFC 6409). ' +
      '"required" here is lower-case English, not the RFC 2119 keyword, so this is ' +
      'normativeSource:prose.',
  },
  {
    id: 'R-5322-3.6-b',
    rfc: 'rfc5322',
    section: '3.6',
    page: 26,
    level: 'MUST',
    party: 'both',
    normativeSource: 'prose',
    text: 'No multiple occurrences of fields (except resent and received)',
    testability: { kind: 'parse' },
    note:
      'The SINGLETON rule. The field table (Figure 1) gives Max=1 for orig-date, ' +
      'from, sender, reply-to, to, cc, bcc, message-id, in-reply-to, references and ' +
      'subject; unlimited for trace/received, resent-*, comments, keywords and ' +
      'optional (X-*) fields. Quoted from the Appendix-B tightening over RFC 822, ' +
      'which states the rule as prose; the authoritative counts are the table. A ' +
      'duplicate singleton (two From, two Date) is a real malformation and a ' +
      'header-ambiguity/spoofing vector, so the validator flags it.',
  },
  {
    id: 'R-5322-3.6-c',
    rfc: 'rfc5322',
    section: '3.6',
    page: 18,
    level: 'SHOULD NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'header fields SHOULD NOT be reordered when a message is transported or ' +
      'transformed',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds our RELAY/transform behaviour (do not reorder header fields when ' +
        'forwarding), not the parser. Testable once the outbound-relay harness ' +
        'exists (it can compare the delivered field order to the submitted order); ' +
        'the message parser cannot observe it.',
    },
    note:
      'Registered so the reorder SHOULD NOT is accounted for. The stronger MUST NOT ' +
      'for trace/resent field ordering (§3.6.6/3.6.7) is a separate future entry.',
  },
] as const satisfies readonly RequirementDef[];
