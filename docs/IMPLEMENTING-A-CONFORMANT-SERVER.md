# Implementing a conformant SMTP receiver — what this suite has learned

This is the bridge from the conformance suite to the server it exists to enable. It distils,
into actionable guidance, what building and hardening the suite surfaced: the RFC 5321
requirements that are easy to get wrong, the places implementations have historically diverged
(with real CVEs), and the latitude the spec grants that a naive implementer over-constrains.

Every point here traces to a register requirement, a corpus test, or the divergence research
in `docs/research/`. Read it before writing the server, and run the suite against the server
as you build.

## 1. Line endings are the whole ballgame — get `<CRLF>` exactly right

This is the single most important thing, and the source of the worst real-world bugs.

- **Only `<CRLF>` (0x0D 0x0A) terminates a line or the DATA phase.** RFC 5321 §2.3.8:
  implementations MUST NOT recognise any other character or sequence as a terminator.
- **Reject a bare `<LF>` or bare `<CR>`; never act on it.** §4.1.1.4 is explicit: "SMTP server
  systems MUST NOT [accept lines ending only in `<LF>`], even in the name of improved
  robustness." A server that honours a bare `<LF>` is the far end of an **SMTP smuggling**
  attack (SEC Consult, Dec 2023, CVE-2023-51764/65/66 against Postfix/Sendmail/Exim).
- **The specific killers, all of which MUST NOT end the DATA phase** (only `<CRLF>.<CRLF>`
  does): `<LF>.<LF>`, `<LF>.<CR><LF>` (the one all three major MTAs mishandled), `<CR>.<CR>`
  (Cisco). See `docs/research/smtp-divergence.md` §1 for the exact bytes and who fell to each.
- **How to be safe:** parse the input stream strictly. Do not "normalise" a bare `<LF>` into a
  `<CRLF>` at the smtpd layer (Postfix's old default did, and it was the vulnerability). Reject
  the line with a `5yz` and, if you like, drop the connection. Both are conformant hardening —
  the suite blesses a server that rejects; it only fails one that *executes* a bare-LF command.

## 2. Take no action on an unterminated line

§2.4: "The receiver will take no action until this [`<CRLF>`] sequence is received." Do not
parse or reply to a command line until you have the terminator. A server that replies early is
acting on incomplete input — the same defect family as honouring a bare LF, and a smuggling
primitive.

## 3. STARTTLS: discard everything buffered at the TLS handshake

RFC 3207. When a client sends `STARTTLS`, after you reply 220 and switch to TLS you **MUST
discard any buffered plaintext** received before the handshake. A server that keeps the buffer
processes an injected plaintext command as if it arrived encrypted — the **command injection**
class (CVE-2011-0411; the NO STARTTLS paper found ~320,000 vulnerable servers). Concretely:
after the 220, throw away unread bytes; do not carry them into the TLS session. Also re-issue
nothing learned pre-TLS: the post-handshake EHLO starts fresh.

## 4. Reply codes: three digits, first digit 2-5, `<SP>` or `-` separator

§4.2. A reply is exactly three digits (`%x32-35 %x30-35 %x30-39` — first 2-5, second 0-5,
third 0-9), then `<SP>` (final line) or `-` (continuation), then text, then `<CRLF>`.

- **Every command generates exactly one reply.** Not zero, not two. Two replies to one command
  is a desync (and a pipelining smuggling vector). The suite's §4.2-a check exists for this.
- **Multiline replies repeat the same code on every line**, `-` on all but the last, `<SP>` on
  the last.
- **Reply text is 7-bit** (`HT` + `%d32-126`). Do not leak a raw UTF-8 hostname or an unencoded
  local-part into reply text.
- Keep reply lines ≤ 512 octets including the `<CRLF>` (§4.5.3.1.5).

## 5. Command ordering: reject only what you genuinely cannot process

§4.1.4. `503` is for commands "out of order to the degree that they cannot be processed":

- **RCPT before MAIL → 5yz** (no reverse-path buffer). **DATA before any RCPT → 5yz** (no
  recipients). These you MUST reject.
- **But MAIL before EHLO is NOT an error you must reject** — §4.1.4-k says process commands even
  with no prior EHLO. Do not `503` a `MAIL` just because the client skipped `EHLO`.
- Mandatory commands (EHLO, HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT, VRFY) MUST be *recognised*
  — never answer `500 command not recognized` to one of them (§4.5.1-b, §4.3.2-e).

## 6. Command semantics that are easy to get subtly wrong

- **RSET** discards the transaction (sender, recipients, data) and replies `250`. It MUST NOT
  close the connection — that is reserved for QUIT (§4.1.1.5).
- **NOOP, VRFY, EXPN, HELP MUST NOT affect the transaction buffers.** A NOOP mid-transaction
  must not forget the sender. (The suite's command-buffer-effects module tests exactly this.)
- **QUIT** replies `221` then closes cleanly (a FIN, not an RST — an abrupt reset can truncate
  the client's view of the final reply). The server MUST NOT close before QUIT except with a
  `421` shutdown reply (§4.1.1.10, §3.8).
- **HELO** MUST be supported and MUST NOT draw an EHLO-style multiline extension list (§3.2-b).
  A multiline *prose* banner is fine; advertising extensions to a HELO is not.
- **`Postmaster`** as a local-part is case-insensitive (§4.1.1.3-m) — unusual, since local-parts
  are otherwise case-sensitive.
- **Source routes** (`<@a,@b:user@c>`) MUST be *recognised* (parsed) even though you may then
  reject the recipient for policy. "Recognise" ≠ "accept": a `550` is fine, a `501` syntax
  error is the violation (§4.1.1.3-b).

## 7. Sizes: these are floors you MUST accept, not ceilings you enforce

§4.5.3.1. You MUST be able to *receive* at least: 64-octet local-part, 255-octet domain,
512-octet command line, 1000-octet text line, 100 recipients. You MAY accept more. Do not
reject input that is within these minimums for being "too long."

## 8. Delivery policy: what the RFC actually mandates (and what it doesn't)

The register repeatedly stopped the suite from over-asserting here — the same traps apply to
the server:

- **Reject an undeliverable recipient you KNOW is undeliverable with a `5yz`** (§3.3-i). But you
  are NOT obliged to verify at RCPT time — accepting an unknown recipient and bouncing later
  (or async) is conformant (and standard anti-harvesting practice). The MUST is conditioned on
  *knowing*.
- **A `4yz` is a temporary deferral, not a rejection.** Greylisting (a `450` on first contact)
  is conformant and ubiquitous. Do not treat your own `4yz` as a permanent verdict, and expect
  clients to retry.
- **You MAY decline to relay** (§3.6.1-b) — refusing to be an open relay is a permission the RFC
  grants, not a MUST it imposes (though operationally you absolutely should refuse). If you
  decline for policy, a `550` is the SHOULD (§3.6.2-c).
- **Support `postmaster`** at your own domain (§4.5.1) — the one address every server must have.

## 9. Delivery transparency: deliver exactly what you received

Policy (section 8) is about what you *accept*. Transparency is about not *corrupting* what you
accepted on its way to the mailbox or the next hop. None of this is visible on the SMTP
connection — it only shows up in the delivered message — which is why this suite tests it with a
receiving sink (a downstream server the system under test relays to; see `src/testing/sink-server.ts`).
Every one of these is a MUST, and every one is easy to get subtly wrong:

- **Dot-un-stuffing (§4.5.2).** The client doubles any body line that begins with a `.`; you MUST
  delete that leading `.` before storing/relaying. Forget it and every leading-period line in
  delivered mail silently grows an extra dot. (The `<CRLF>.<CRLF>` terminator itself is the
  end-of-data marker, not body content — see section 1.)
- **Insert a `Received:` trace line at the top (§4.4).** When you receive a message for delivery
  or relay you MUST prepend trace information to the head of the content. A relay that forwards
  the body untouched is non-conformant (and unauditable).
- **Preserve the local-part case (§2.4-c/-d).** `Foo@example.com` and `foo@example.com` are
  potentially different mailboxes; the local-part is case-sensitive, so you MUST NOT lowercase it
  as you relay. The domain, by contrast, IS case-insensitive.
- **Deliver all characters, including control characters (§4.5.2-e).** Horizontal tabs, vertical
  tabs, and other control octets in the body MUST reach the mailbox intact — do not strip or
  normalise them. (8-bit octets are a separate question gated on `8BITMIME`/SMTPUTF8.)

## 10. SHOULD and MAY are not MUST — don't be stricter than the spec

A large fraction of RFC 5321 is SHOULD/MAY. The suite's whole outcome model exists to avoid
failing a server for declining a SHOULD. As an implementer, the inverse: you have latitude.
`8BITMIME` SHOULD be supported but need not be; VRFY MAY return `252 Cannot VRFY`; NOOP SHOULD
ignore its arguments but MAY reject them. Knowing where you have latitude keeps the
implementation honest and interoperable.

## 11. EAI / SMTPUTF8 (RFC 6531), if you implement it

UTF-8 in envelope addresses is permitted only after the client issues `SMTPUTF8` (announced in
EHLO). Without it, envelope commands stay ASCII (§2.4). When relaying to a downstream that does
not advertise SMTPUTF8, do not silently downgrade a UTF-8 address — fail it (Postfix's
documented behaviour; see `docs/research/smtp-divergence.md` §6).

---

## Using the suite as you build

- `node src/cli.ts coverage` shows every RFC 5321 requirement and its state. Everything marked
  `not-testable` is something this receiver-side suite cannot observe — but it is still a
  requirement your server must meet; the register text is the spec.
- Point the suite at your server (`node src/cli.ts run --config your-server.json`) from the
  first working EHLO onward. A finding is a `MUST`/`MUST NOT` violation with the exact byte
  transcript.
- Calibrate against Postfix and Exim first (`reference-servers/`) so you trust the suite before
  trusting its verdict on your server.
- The register notes (`src/register/sections/`) carry per-requirement traps that did not fit
  here. When a requirement puzzles you, read its note.
