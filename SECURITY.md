# Security policy

cutiemail is a from-scratch mail server: it hand-builds the SMTP and IMAP engines, the MIME
parser, and the SPF/DKIM/DMARC/ARC crypto on the byte layer. That makes it security-sensitive by
nature — a parser or auth bug here is an internet-facing bug — so reports are genuinely welcome.

This is a personal, correctness-focused project, not a funded security programme: there is no
bounty, and responses are best-effort by one maintainer. What there *is* is a real appetite to fix
exploitable bugs, and a codebase built to be reproduced against — every hostile-input surface has
been through the maintainer's own security review, with a regression test for each defended attack
(see [docs/TESTING.md](docs/TESTING.md)). There has been **no third-party security audit** yet —
it's on the honest-limitations list in [the deployment guide](docs/DEPLOYMENT.md), and independent
scrutiny is exactly what a report like yours contributes.

## Reporting a vulnerability

**Email <jamie@lord.technology>. Please do not open a public GitHub issue for a security bug** —
report privately first so a fix can land before details are public.

A good report includes:

- the affected commit (or release) and how you ran it;
- a concrete, minimal reproduction — the bytes/commands sent and what happened. A finding that
  can be replayed is worth ten that can only be argued;
- the impact: who the attacker is (unauthenticated remote / authenticated user), what access they
  need, and what they achieve.

I aim to acknowledge a report within a week and to agree a disclosure timeline with you. Coordinated
disclosure is appreciated — please give a reasonable window to ship a fix before publishing. Credit
is offered for valid reports unless you'd rather stay anonymous.

## What's in scope

The classes this project most cares about getting right, with a concrete attack:

- **SMTP smuggling / message-boundary confusion** — bare `CR`/`LF` end-of-data tricks
  (`<LF>.<LF>`, `<CR>.<CR>`), pipelining, STARTTLS command injection (RFC 3207 §4.2).
- **Sender authentication bypass / spoofing** — an `Authentication-Results` forgery, a
  `From`-header parser divergence that yields a `dmarc=pass` for mail the domain didn't authorise,
  or a DMARC/SPF/DKIM alignment error.
- **Authorization** — the submission sender-authorization gate (an authenticated account sending
  *as* another account or a foreign domain, ADR 0015); cross-account mailbox isolation over IMAP.
- **Open relay / backscatter** — accepting or relaying mail for a domain we don't host.
- **SSRF and outbound safety** — the outbound MX resolution / relay path reaching an internal
  address or being steered by a hostile DNS answer.
- **Credential and key handling** — anything that exposes SCRAM material, an account password, or
  the DKIM private key; TLS downgrade / MTA-STS enforcement bypass.
- **Denial of service** — a single message or command that exhausts memory or wedges the
  single-threaded event loop (parser blow-ups, unbounded buffering).

## What's *not* a vulnerability

Some behaviour is deliberately naive and documented as such — reporting it as a bug just means it's
already a recorded decision:

- **The bundled development TLS certificate's private key is public** (it's committed in
  `src/testing/`). That's intended for local development only, and the daemon **refuses to boot**
  with it on a non-loopback interface. "The dev cert key is in the repo" is by design, not a leak.
- Choices flagged as intentionally minimal in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ("Known
  limitations") and [docs/TESTING.md](docs/TESTING.md) — read those first.
- Findings that require having already compromised the host (local root reading `0600` databases
  the owner can read anyway), or that depend on the operator misconfiguring against the docs.

If you're unsure whether something is in scope, err toward reporting it privately — a quick email
is cheaper than a missed bug.
