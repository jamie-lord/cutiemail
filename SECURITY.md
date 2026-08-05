# Security policy

cutiemail is a from-scratch mail server. It hand-builds the SMTP and IMAP engines, the MIME
parser, and the SPF/DKIM/DMARC/ARC logic on the byte layer, over Node's own crypto primitives. This
makes it security-sensitive by nature. A parser or auth bug here is an internet-facing bug, so
reports are welcome.

This is a personal, correctness-focused project, not a funded security programme. There is no
bounty, and one maintainer gives best-effort responses. But there is a real appetite to fix
exploitable bugs, and a codebase built to be reproduced against. The maintainer reviewed every
hostile-input surface, with a regression test for each defended attack (see
[docs/TESTING.md](docs/TESTING.md)). There has been **no third-party security audit** yet. It is on
the honest-limitations list in [the deployment guide](docs/DEPLOYMENT.md), and independent scrutiny
is exactly what a report like yours contributes.

## Reporting a vulnerability

**Email <jamie@lord.technology>. Do not open a public GitHub issue for a security bug.** Report it
privately first, so a fix can land before the details are public.

A good report includes:

- the affected commit (or release), and how you ran it.
- a concrete, minimal reproduction: the bytes and commands that you sent, and what happened. A
  finding that you can replay is worth ten that you can only argue.
- the impact: who the attacker is (unauthenticated remote or authenticated user), what access they
  need, and what they achieve.

The maintainer aims to acknowledge a report within a week, and to agree a disclosure timeline with
you. Coordinated disclosure is appreciated. Before you publish, give a reasonable window to ship a
fix. The maintainer offers credit for valid reports, unless you would rather stay anonymous.

## What's in scope

These are the classes that the project most wants to get right, each with a concrete attack:

- **SMTP smuggling / message-boundary confusion**: bare `CR`/`LF` end-of-data tricks
  (`<LF>.<LF>`, `<CR>.<CR>`), pipelining, STARTTLS command injection (RFC 3207 §4.2).
- **Sender authentication bypass / spoofing**: an `Authentication-Results` forgery, a
  `From`-header parser divergence that yields a `dmarc=pass` for mail that the domain did not
  authorise, or a DMARC/SPF/DKIM alignment error.
- **Authorization**: the submission sender-authorization gate (an authenticated account that sends
  *as* another account or a foreign domain, ADR 0015). Also cross-account mailbox isolation over
  IMAP.
- **Open relay / backscatter**: the server accepts or relays mail for a domain that it does not
  host.
- **SSRF and outbound safety**: the outbound MX resolution and relay path reaches an internal
  address, or a hostile DNS answer steers it.
- **Credential and key handling**: anything that exposes SCRAM material, an account password, or
  the DKIM private key. Also a TLS downgrade or an MTA-STS enforcement bypass.
- **Denial of service**: a single message or command that exhausts memory or wedges the
  single-threaded event loop (parser blow-ups, unbounded buffering).

## What's *not* a vulnerability

Some behaviour is deliberately naive, and the docs say so. If you report it as a bug, it is
already a recorded decision:

- **The bundled development TLS certificate's private key is public** (it is committed in
  `src/testing/`). It is intended for local development only, and the daemon **refuses to boot**
  with it on a non-loopback interface. "The dev cert key is in the repo" is by design, not a leak.
- Choices flagged as intentionally minimal in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ("Known
  limitations") and [docs/TESTING.md](docs/TESTING.md). Read those first.
- Findings that need an already-compromised host (local root reads `0600` databases that the owner
  can read anyway), or that depend on an operator who misconfigures against the docs.

If you are unsure whether something is in scope, report it privately. A quick email is cheaper than
a missed bug.
