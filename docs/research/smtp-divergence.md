# SMTP implementation divergence: encodable findings

Source: a survey of the SMTP-divergence and email-security literature (2023 to 2026), checked
against primary sources. This file gives the usable distillation. Each entry is something the
corpus can test. Each entry lists the exact wire primitive, the affected implementations, and
the RFC clause at stake.

This document records what a suite built only from the RFC would miss. The spec text on line
endings was *clear*, but implementations diverged anyway. That gap is the whole reason to build
a correctness-focused suite.

## 1. SMTP smuggling: end-of-data confusion (SEC Consult, Timo Longin, 18 Dec 2023)

RFC-conformant end-of-data is `<CR><LF>.<CR><LF>`. Affected servers accepted non-standard
variants. The attack lives in the DISAGREEMENT between two servers. An outbound server passes a
variant unfiltered, and an inbound server treats it as end-of-data. This disagreement lets an
attacker inject a second, SPF-passing, spoofed message.

The verified end-of-data variants, and who mishandled them:

| Primitive (bytes) | Inbound acceptors | Outbound passers |
|---|---|---|
| `<LF>.<LF>` (`0a 2e 0a`) | Fastmail, Runbox | Exchange Online **rejected** this (`550 5.6.11 SMTPSEND.BareLinefeedsAreIllegal`) |
| `<LF>.<CR><LF>` (`0a 2e 0d 0a`) | **Postfix, Sendmail, Exim**, Fastmail, Runbox | **GMX/Ionos, Exchange Online** passed unfiltered |
| `<CR>.<CR>` (`0d 2e 0d`) | Cisco Secure Email Gateway (default "Clean" converts bare CR/LF → CRLF) | n/a |
| `<CR><CR><LF>.<CR><CR><LF>` | SEC Consult variant | n/a |

`<LF>.<CR><LF>` is the highest-value test primitive. The three major open-source MTAs all
mishandled it.

CVEs: **CVE-2023-51764** Postfix (≤3.8.4), **CVE-2023-51765** Sendmail (≤8.17.2, fixed 8.18),
**CVE-2023-51766** Exim (≤4.97, fixed 4.97.1/4.98), **CVE-2024-27305** aiosmtpd. Coordination:
CERT/CC VU#302671. Wietse Venema gives the root cause: a decades-old Sendmail compatibility
decision to accept bare `<LF>` line endings.

Exim's full trigger set (from the Exim advisory): `LF . LF`, `CR LF . LF`, `LF . CR LF`.
The Exim attack also needs DATA (not BDAT). It also needs Exim to offer both PIPELINING and
CHUNKING inbound. If you disable either one, a synchronisation check trips.

### Postfix mitigation defaults (a conformance baseline to test against)

- `smtpd_forbid_bare_newline`: **before 3.9 it defaults to `no`** (bare LF accepted!). **As of
  3.9 it defaults to `normalize`** (bare LF → CRLF, not rejected). In `reject` mode it replies
  `550` (`smtpd_forbid_bare_newline_reject_code`) with `Error: bare <LF> received`, then it
  disconnects.
- `smtpd_forbid_bare_newline_exclusions` defaults to `$mynetworks`. So even when enabled, it
  exempts local clients. A conformance run from inside `$mynetworks` sees the *unmitigated*
  behaviour, which is a real test-setup trap.
- `smtpd_forbid_unauth_pipelining`: as of 3.9 it defaults to `yes` (it disconnects RFC 2920
  violators). Postfix backported it to 3.8.1/3.7.6/3.6.10/3.5.20.

### RFC 5321bis status on smuggling

draft-ietf-emailcore-rfc5321bis-44 (31 Jul 2025) reaffirms CRLF as the only terminator. It
states that implementations MUST NOT recognise any other sequence. But **receiver-side
rejection of bare CR/LF stays discretionary (MAY), not mandatory**. So the bis does NOT close
smuggling at the spec level. §7 (Security Considerations) of the draft does not mention
smuggling.

## 2. USENIX Security 2025 (Wang Chuhan et al): 13-payload smuggling corpus

The paper defines a 13-payload end-of-data test corpus (Table 1, A1 through A13) of
`\n`/`\r`/`\r\n` permutations around the dot. As of the 2025 study, the latest
Postfix/Sendmail/Exim mitigate the classic forms. But measurement still found 19 of 22 public
services and 1,577 private services vulnerable to some variant. It also found ~512 email
security gateways that amplify it. 13 of the tested sending services applied dot-stuffing. The
full A1 through A13 permutation set is in the paper PDF
(gangw.cs.illinois.edu/smtp-usenix25.pdf). The suite's smuggling corpus covers the high-signal
variants below.

## 3. STARTTLS command injection: NO STARTTLS (Poddebniak et al, USENIX Sec 2021; CVE-2011-0411)

**Primitive:** send `STARTTLS<CR><LF>` plus a trailing plaintext command in the SAME TCP
segment, for example `STARTTLS\r\nRSET\r\n`. A vulnerable server buffers the whole segment. It
starts TLS after it acks STARTTLS, but it does NOT flush the buffer. So the server parses the
injected command as if the command arrived inside the TLS session. RFC 3207 requires the server
to discard any buffered state at the plaintext→TLS transition.

There are two orthogonal classes. **Command injection** (B_C) turns a plaintext command into an
encrypted response, and is severe in SMTP. **Response injection** (B_R) is severe in POP3/IMAP,
where the system archives session data. An Internet scan found ~320,000 servers (~2%)
vulnerable. Server CVEs: Dovecot CVE-2021-33515, s/qmail CVE-2020-15955, Citadel
CVE-2020-29547, SmarterMail CVE-2020-29548, Courier CVE-2021-38084, Mercury/32 CVE-2021-33487.
Tooling: the EAST toolkit / command-injection-tester.

**Testable directly by us:** our transport already flags any bytes that it buffers before the
TLS handshake (`transport.ts` startTls). A corpus test sends `STARTTLS\r\nNOOP\r\n` in one write
and asserts that the server does NOT answer the NOOP inside TLS. This test maps to RFC 3207. The
suite runs it under the extensions corpus.

## 4. Sender-spoofing taxonomy (Shen et al, USENIX Sec 2021): the 5321/5322-level cases

The paper defines 14 attacks (A1 through A14) across sending/receiving/forwarding/rendering.
The attacks exploit four identity fields: AUTH username, MAIL FROM (envelope), From (body),
Sender. The cases below are pure transport/parsing divergence. They are worth encoding where
they touch RFC 5321:

- **A3 empty MAIL FROM `<>`**: RFC 5321 permits it (bounce path). It interacts with SPF `MAIL
  FROM` checks. Our R-5321 register has the null reverse-path requirements (§4.5.5).
- **A4/A5 multiple From headers / multiple addresses**: RFC 5322 §3.6 says one From. Divergent
  handling bypasses DMARC. This is a 5322 (message) concern, not 5321 transport. Note it for a
  future message-format corpus. It is out of scope for the transport suite.
- **A6 address-parsing inconsistency**: truncation/quoting tricks in the RFC 5321/5322 mailbox
  grammar, where the envelope parser and the header parser disagree. This is directly relevant
  to our §4.1.2 mailbox-syntax corpus.
- **A7 encoded-word (RFC 2047) in From**: the server does not decode `=?utf-8?b?...?=` before
  DMARC domain extraction. This is 5322-level. Note it for the message corpus.

## 5. ESpoofing (github.com/mo-xiaoxi/ESpoofing): the fuzzing companion to Shen 2021

ESpoofing is an ABNF-grammar-driven header fuzzer. `pre_fuzz.py` extracts RFC ABNF rules (for
example RFC 5322 `from`). It mutates them by header repetition, space insertion, Unicode
injection, RFC 2047 encoded-word encoding, and case variation. The samples are in
`config/fuzz.json`. **No licence stated**, so treat it as a reference for mutation *techniques*,
not a corpus to vendor. The mutation catalogue (space-before-colon, CRLF injection,
encoded-word, case variation, repetition) is a ready-made checklist for ABNF-driven generation
in the argument-syntax corpus.

## 6. EAI / SMTPUTF8 (RFC 6531) divergence: Postfix as the documented baseline

- Postfix accepts UTF-8 in address domains **only after** the client issues `SMTPUTF8` on
  MAIL FROM/VRFY (Postfix announces `250 SMTPUTF8` in EHLO). This is a wire-testable gating
  condition.
- **Non-downgrade divergence point:** consider a relay to a downstream MTA that does NOT
  advertise SMTPUTF8. Postfix delivers only if no header/sender/recipient contains UTF-8. If any
  one does, it **fails the recipient with an SMTPUTF8 DSN and does not downgrade**. Postfix does
  no IDN/UTF-8↔ASCII conversion. This is the exact non-EAI-hop divergence to test.
- Defaults: `smtputf8_enable` on. `smtputf8_autodetect_classes = sendmail, verify`.

## What the suite encodes from this research

1. **The smuggling corpus** covers the end-of-data variants above: `<LF>.<LF>`,
   `<LF>.<CR><LF>`, `<CR>.<CR>`, and the `<CR><CR><LF>` form (§1).
2. **STARTTLS injection** is in the extensions corpus (§3): pre-handshake injection,
   smuggle-into-TLS, and the post-handshake reset.
3. **The argument-syntax corpus** encodes the ESpoofing mutation catalogue (§5) and the A6
   parsing-inconsistency cases (§4).
4. **The SMTPUTF8 corpus** tests the gating condition and the non-downgrade DSN (§6).
5. **Message-format (RFC 5322) attacks** (A4/A5/A7) are out of scope for this transport
   suite. They belong in a message-level corpus. This file records them, so the omission is a
   decision, not a forgotten gap.
