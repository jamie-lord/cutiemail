/**
 * RFC 5321 §2.3.8 — Lines
 *
 * Verbatim quotes from spec/rfc5321.txt. Do not paraphrase: the register's
 * `every requirement quotes RFC 5321 verbatim` test checks every `text` field
 * against the vendored RFC and will fail on drift.
 *
 * See docs/decisions/0001-spec-baseline.md and src/register/EXTRACTING.md.
 */

import type { RequirementDef } from '../types.ts';

export const S2_3_8 = [
  //
  // The section the whole project arguably exists for. The MUST NOT below is
  // the requirement SMTP smuggling violates: an attacker exploits two MTAs
  // disagreeing about what terminates a line, so a receiver that "helpfully"
  // honours a bare LF is both non-conformant and the far end of a real attack.
  {
    id: 'R-5321-2.3.8-a',
    section: '2.3.8',
    page: 14,
    level: 'MUST NOT',
    party: 'both',
    normativeSource: 'keyword',
    text:
      'Conforming implementations MUST NOT recognize or generate any other ' +
      'character or character sequence as a line terminator.',
    testability: { kind: 'wire' },
    note:
      'Two distinct obligations in one sentence, and the split matters for us. ' +
      '"generate" binds a sender; "recognize" binds a receiver and is the one ' +
      'this suite can observe: send a command terminated by bare LF and see ' +
      'whether the server acts on it. Acting on it is a violation. ' +
      'Directly upstream of the SMTP smuggling class (SEC Consult / Timo ' +
      'Longin, Dec 2023) — but note the vulnerability lives in the ' +
      'DISAGREEMENT between two implementations, so our report must classify ' +
      'the observed behaviour (honoured / rejected / silently normalised) ' +
      'rather than only pass/fail. See task #17. ' +
      'CALIBRATION GROUND TRUTH (2026-07-16): BOTH real servers pointed at this ' +
      'check honour a bare-LF-terminated COMMAND — Exim 4.99.4 replied 250 to a ' +
      'bare-LF EHLO and NOOP, and aiosmtpd 1.4.6 the same. So this MUST NOT is ' +
      'widely violated by production MTAs for command-line terminators (distinct ' +
      'from the DATA-phase end-of-data smuggling that CVE-2023-51766 hardened). ' +
      'The suite is CORRECT to flag it — bare-LF acceptance is exactly the ' +
      'smuggling-adjacent leniency it exists to surface — and a server author ' +
      'using this suite genuinely wants to know. Recorded as a real divergence, ' +
      'not softened: see reference-servers/CALIBRATION-exim.md.',
  },
  {
    id: 'R-5321-2.3.8-b',
    section: '2.3.8',
    page: 14,
    level: 'MAY',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Limits MAY be imposed on line lengths by servers (see Section 4).',
    testability: { kind: 'wire' },
    note:
      'Permission, not obligation — a server imposing a line limit cannot be ' +
      'failed for it. The floor it must not go below lives in §4.5.3.1 and is ' +
      'the testable half. Registered so the MAY is visibly accounted for.',
  },
  {
    id: 'R-5321-2.3.8-c',
    section: '2.3.8',
    page: 14,
    level: 'MUST NOT',
    party: 'client',
    normativeSource: 'keyword',
    text:
      'SMTP client implementations MUST NOT transmit these characters except ' +
      'when they are intended as line terminators and then MUST, as indicated ' +
      'above, transmit them only as a <CRLF> sequence.',
    testability: {
      kind: 'not-testable',
      reason:
        'Binds the client. This suite is the client, so it can only comply, ' +
        'not observe — and it deliberately violates this requirement in the ' +
        'smuggling corpus, which is the correct thing for a test client to do.',
    },
    note:
      'Registered rather than dropped: deleting client-side requirements would ' +
      'shrink the denominator and flatter our coverage. See decision 0001 ' +
      '("Scope: what we test").',
  },
] as const satisfies readonly RequirementDef[];
