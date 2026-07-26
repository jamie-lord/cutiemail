/**
 * RFC 9051 (IMAP4rev2) §5.2, §5.5, §6.1.1, §6.1.3, §6.2.2 — the session surface: what the server
 * announces, how it says goodbye, how it authenticates, and the unsolicited updates it owes a
 * client that is just sitting there.
 *
 * The §5.2 requirement is the one to read twice. "A server MUST send mailbox size updates
 * automatically if a mailbox size change is observed during the processing of a command" is what
 * makes a mail client feel alive: new mail appears without the user doing anything. It is also
 * invisible to any single-connection test, because it is about what connection A is told when
 * connection B changes something — which is a category of requirement this register had no way to
 * express while it was entirely `parse`.
 *
 * SCOPE (ADR 0007). This server offers IMAP over implicit TLS only; there is no cleartext port and
 * no STARTTLS on the IMAP side. The requirements that bind cleartext ports are registered with the
 * condition recorded rather than dropped, because "we do not expose the surface that requirement
 * governs" is a different and much better answer than silence.
 *
 * Verbatim quotes from spec/rfc9051.txt.
 */

import type { RequirementDef } from '../../types.ts';

const AUTHED = 'an authenticated session';
const TWO_SESSIONS = 'two authenticated sessions on the same account, both able to select one mailbox';

export const IMAP_SESSION_WIRE = [
  {
    id: 'R-9051-5.2-a',
    rfc: 'rfc9051',
    section: '5.2',
    page: 29,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'A server MUST send mailbox size updates automatically if a mailbox size change is observed during the processing of a command.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_SESSIONS },
    note:
      'The untagged EXISTS that makes new mail appear in a client without the user asking. '
      + 'Unobservable on one connection: the case needs a second session to deliver into the '
      + 'mailbox, then any command on the first (NOOP is the conventional one) must carry the '
      + 'updated EXISTS. A server that only reports the count at SELECT time passes every '
      + 'single-connection test and leaves users pressing refresh.',
  },
  {
    id: 'R-9051-5.2-b',
    rfc: 'rfc9051',
    section: '5.2',
    page: 29,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'A server SHOULD send message flag updates automatically, without requiring the client to request such updates explicitly.',
    testability: { kind: 'wire-with-fixture', fixture: TWO_SESSIONS },
    note:
      'The flag half of the same behaviour, and the reason marking a message read on a phone greys '
      + 'it out on a laptop. A SHOULD, so declining is recorded latitude — but this server does '
      + 'propagate flag changes between connections sharing an account, and a case pins it.',
  },
  {
    id: 'R-9051-5.5-a',
    rfc: 'rfc9051',
    section: '5.5',
    page: 30,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the server detects a possible ambiguity, it MUST execute commands to completion in the order given by the client.',
    testability: { kind: 'wire-with-fixture', fixture: AUTHED },
    note:
      'Pipelining safety. A client may send several commands without waiting, and the server may '
      + 'reorder or overlap them — except where doing so would change the answer, and then order is '
      + 'mandatory. Observable by pipelining a sequence whose result depends on ordering (a STORE '
      + 'followed by a FETCH of the same message) in a single write, and requiring the answers to '
      + 'reflect the client\'s order.',
  },
  {
    id: 'R-9051-6.1.1-a',
    rfc: 'rfc9051',
    section: '6.1.1',
    page: 32,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The server MUST send a single untagged CAPABILITY response with "IMAP4rev2" as one of the listed capabilities before the (tagged) OK response.',
    testability: { kind: 'wire' },
    note:
      'Three obligations packed into one sentence, and each can fail alone: exactly ONE untagged '
      + 'CAPABILITY (not two), containing IMAP4rev2, arriving BEFORE the tagged OK. Observable on a '
      + 'bare connection with no account, which is why this is `wire` rather than '
      + '`wire-with-fixture`. ADR 0007\'s amendment permits also advertising IMAP4rev1 as a '
      + 'compatibility signal, and that does not affect this requirement: it asks that rev2 be '
      + 'present, not that it be alone.',
  },
  {
    id: 'R-9051-6.1.1-b',
    rfc: 'rfc9051',
    section: '6.1.1',
    page: 32,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Client and server implementations MUST implement the STARTTLS (Section 6.2.1) and LOGINDISABLED capabilities on cleartext ports.',
    testability: { kind: 'not-testable', reason: 'This server exposes no cleartext IMAP port, so the condition the requirement binds ("on cleartext ports") never obtains.' },
    note:
      'IMAP is served over implicit TLS only (port 993). The requirement is conditional on offering '
      + 'a cleartext port, and declining to offer one satisfies it vacuously and by a wider margin '
      + 'than implementing STARTTLS would — there is no downgrade to strip. Registered rather than '
      + 'omitted so that the day a cleartext port is ever added, this is already here waiting with '
      + 'its two obligations attached.',
  },
  {
    id: 'R-9051-6.1.1-c',
    rfc: 'rfc9051',
    section: '6.1.1',
    page: 32,
    level: 'MUST',
    party: 'both',
    normativeSource: 'keyword',
    text: 'Client and server implementations MUST also implement AUTH=PLAIN (described in [PLAIN]) capability on both cleartext and Implicit TLS ports.',
    testability: { kind: 'wire' },
    note:
      'Unconditional for us: "on both cleartext and Implicit TLS ports" includes the implicit-TLS '
      + 'port this server serves. The capability has to be ADVERTISED, not merely accepted — a '
      + 'client chooses its mechanism from the CAPABILITY list, so an unadvertised AUTH=PLAIN is '
      + 'one a conforming client will never try.',
  },
  {
    id: 'R-9051-6.1.3-a',
    rfc: 'rfc9051',
    section: '6.1.3',
    page: 34,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The server MUST send a BYE untagged response before the (tagged) OK response, and then close the network connection.',
    testability: { kind: 'wire' },
    note:
      'LOGOUT is the one place the ordering is spelled out completely: BYE, then the tagged OK, then '
      + 'the close. A client that sees the connection drop without the BYE cannot distinguish a '
      + 'clean logout from a network failure — the same distinction the shutdown path owes '
      + '(§7.1.5), and a good example of a requirement whose two sites are easy to fix separately.',
  },
  {
    id: 'R-9051-6.2.2-a',
    rfc: 'rfc9051',
    section: '6.2.2',
    page: 37,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the server receives such a response, or if it receives an invalid base64 string (e.g., characters outside the base64 alphabet or non-terminal "="), it MUST reject the AUTHENTICATE command by sending a tagged BAD response.',
    testability: { kind: 'wire' },
    note:
      'BAD, specifically — not NO. The distinction is load-bearing for a client: NO means the '
      + 'credentials were wrong and prompting the user again is sensible, BAD means the client '
      + 'itself is broken and retrying will not help. A server that answers NO to malformed base64 '
      + 'sends clients into a re-prompt loop. Observable with no account at all.',
  },
  {
    id: 'R-9051-6.2.2-b',
    rfc: 'rfc9051',
    section: '6.2.2',
    page: 37,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the requested authentication mechanism is not supported, the server SHOULD reject the AUTHENTICATE command by sending a tagged NO response.',
    testability: { kind: 'wire' },
    note:
      'The mirror of the case above: an unsupported MECHANISM is NO (a policy answer), malformed '
      + 'DATA is BAD (a protocol answer). Getting these the wrong way round is invisible until a '
      + 'client behaves oddly, which is why both are registered rather than one standing for both.',
  },
  {
    id: 'R-9051-6.2.2-c',
    rfc: 'rfc9051',
    section: '6.2.2',
    page: 38,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Note: a server implementation MUST implement a configuration in which it does NOT permit any plaintext password mechanisms, unless the STARTTLS command has been negotiated, TLS has been negotiated on an Implicit TLS port, or some other mechanism that protects the session from password snooping has been provided.',
    testability: { kind: 'wire' },
    note:
      'Satisfied by construction here, and worth registering for exactly that reason: this server '
      + 'has no configuration in which IMAP is served without TLS, so there is no arrangement in '
      + 'which a plaintext mechanism is offered unprotected. The observable form is that the only '
      + 'IMAP listener is an implicit-TLS one — which is checkable, and would fail loudly if a '
      + 'cleartext listener were ever added without the guard.',
  },
] as const satisfies readonly RequirementDef[];
