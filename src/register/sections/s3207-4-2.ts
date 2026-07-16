/**
 * RFC 3207 §4.2 — Result of the STARTTLS Command (the security surface RFC 5321
 * itself does not cover).
 *
 * The register is overwhelmingly RFC 5321, but STARTTLS command-injection (the
 * CVE-2011-0411 / "NO STARTTLS" class — SEC Consult 2023 revisited it) is a
 * genuine, wire-observable conformance defect that a serious SMTP conformance
 * suite must catch, and it lives in RFC 3207, not 5321. These entries carry
 * `rfc: 'rfc3207'`, so the verbatim gate checks their `text` against
 * spec/rfc3207.txt, not spec/rfc5321.txt. Ids are R-3207-<section>-<letter>.
 *
 * See docs/decisions/0006-starttls-injection.md and docs/research/smtp-divergence.md §3.
 */

import type { RequirementDef } from '../types.ts';

export const S3207_4_2 = [
  {
    id: 'R-3207-4.2-a',
    rfc: 'rfc3207',
    section: '4.2',
    page: 4,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text:
      'The server MUST discard any knowledge obtained from the client, such as ' +
      'the argument to the EHLO command, which was not obtained from the TLS ' +
      'negotiation itself.',
    testability: { kind: 'wire' },
    note:
      'The STARTTLS command-injection defence (CVE-2011-0411, "NO STARTTLS"). The ' +
      'attack: a MITM pipelines a plaintext command in the SAME TCP segment as ' +
      'STARTTLS ("STARTTLS\\r\\nRSET\\r\\n"); a vulnerable server buffers the ' +
      'trailing bytes across the 220 and processes them as if they arrived inside ' +
      'the TLS session, letting the attacker inject commands the client never ' +
      'sent. A conformant server discards that buffered plaintext. TESTABLE ' +
      'WITHOUT A FULL HANDSHAKE: send "STARTTLS\\r\\n<injected>\\r\\n" in one ' +
      'write, read the 220, then assert the server is SILENT — a vulnerable server ' +
      'answers the injected command (e.g. a 250 to the injected NOOP), a safe one ' +
      'discards it and awaits the ClientHello. TRAP: the observable is the EXTRA ' +
      'reply, so a timeout/quiet is the CONFORMANT outcome; only an actual reply ' +
      'to the injected command convicts. SCOPE: this covers the pre-handshake ' +
      'plaintext-injection variant. A second variant (smuggling a command so it is ' +
      'replayed INSIDE the TLS stream) needs a completed handshake and is not yet ' +
      'covered — the mutant server models advertise/honour and this pre-handshake ' +
      'discard, not a live TLS session.',
  },
] as const satisfies readonly RequirementDef[];
