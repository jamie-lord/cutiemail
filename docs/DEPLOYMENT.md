# Deploying to a small server and using it with real email

This walkthrough puts the daemon on a little Linux box, points DNS at it, and
gets mail flowing to and from your existing inbox (Gmail, Fastmail, whatever)
through one or more accounts.

It is a **test bench, not a production MTA** (naive on purpose, see
[Known limitations](#known-limitations)). Running it in the real world makes its
gaps show up against real senders and receivers instead of a test harness. In
practice, run it on a **spare domain or a subdomain**, not yet as the only home
of mail you can't lose. There is no spam filter and no third-party security
review. When you're ready to move a real
domain later, [Cutting over a domain you already use](#cutting-over-a-domain-you-already-use)
is the sequencing.

## The shape of it

```mermaid
flowchart LR
    GMAIL["your existing inbox<br/>(Gmail)"]
    subgraph BOX["your Linux box · mail.example.com"]
        DAEMON["the daemon<br/>src/main.ts"]
        DB[("SQLite<br/>control.db + mail-&lt;user&gt;.db")]
        DAEMON --- DB
    end
    CLIENT["a mail client<br/>(Thunderbird / your phone)"]

    GMAIL -->|"SMTP to your MX · 25"| DAEMON
    DAEMON -->|"relay to Gmail's MX · 25"| GMAIL
    CLIENT -->|"submit · 587 AUTH"| DAEMON
    CLIENT -->|"read · 993 IMAPS"| DAEMON
```

One box runs the daemon. Your existing inbox is the far end. A mail client
(Thunderbird on a laptop, or your phone's mail app) talks to the daemon on 587 to
send and 993 to read. The daemon is *your* server; it does the talking to Gmail.

## Before you start

Four things decide whether this is worth your afternoon (it takes about one):

- **A small Linux VPS with port 25 open both ways** (~€4/month; the throwaway
  path below is billed by the hour). This is the make-or-break item: most home
  ISPs block port 25 entirely, and most cloud providers block *outbound* 25 on
  new accounts until you ask. Check yours before doing anything else.
- **A domain whose DNS you control.** A subdomain of one you already own is
  perfect (this guide uses `mail.example.com` throughout).
- **Comfort with a shell and systemd.** You do not need to know Node, npm, or
  TypeScript. Node.js here is only the runtime the server needs, the way a
  Python tool needs Python. Every command you must type is printed in full.
- **An hour or two**, most of it waiting for DNS.

The walkthrough assumes a **Debian/Ubuntu** box. Every package command below is
Debian-family (`apt-get`, `ufw`, the NodeSource `.deb` script). On RHEL-family
distros (Fedora, Rocky, AlmaLinux) substitute `dnf` for `apt-get` and `firewalld`
for `ufw`, and use NodeSource's
[rpm setup script](https://github.com/nodesource/distributions#rpm-distributions)
in place of the deb one. Everything else (the CLI, the systemd unit, the DNS) is
identical.

## The whole job, in order

Every step links to its section; do them top to bottom, each one depends on
the ones before it:

1. [Get the code and Node onto the box](#what-you-need): install Node 22 + git, clone to `/opt/mailserver`.
2. [Prepare the box](#what-you-need): data directory, firewall.
3. [Create your account with `init`](#running-it): **before the daemon ever starts**; the daemon refuses to boot with no accounts.
4. [Generate the DKIM key and print your DNS records with `setup`](#dns), then publish them.
5. [Issue the TLS certificate](#tls-getting-the-certificate-to-the-daemon-and-keeping-it-fresh): certbot, plus the renewal hook.
6. [Install and start the systemd unit](#the-systemd-unit).
7. [Verify: `doctor` (the outside), then `selftest` (the mail path)](#verify-it-end-to-end).
8. [Point your mail client at it](#pointing-your-mail-client-at-it) and email yourself from Gmail.

Prefer containers? [Running it in a container](#running-it-in-a-container) replaces
steps 2, 3, and 6. In a hurry? The throwaway box below automates all of it. Once it's
live, [Keeping itself up to date](#keeping-itself-up-to-date) sets up automatic updates and
[Upgrading by hand](#upgrading-by-hand) covers pulling a new version yourself, and
[Decommissioning](#decommissioning) is the teardown when you're done.

## Quick start: a throwaway Hetzner box (receiving)

Hetzner Cloud is the cheapest way to spin this up and throw it away: an ARM
`cax11` is about **€0.006/hour**, billed by the hour, gone the moment you delete
it. `deploy/hetzner-up.sh` and `deploy/hetzner-down.sh` automate the whole thing.

This path gets **receiving** working: mail *to* `you@mail.example.com` lands in
the mailbox and you read it over IMAP. Sending outward may work too, but check
first: Hetzner blocks outbound port 25 on *new* accounts (established accounts
have it open; test with `nc gmail-smtp-in.l.google.com 25` from the box). For
what receivers demand of outbound mail, see
[Known limitations](#known-limitations).

```mermaid
flowchart TB
    up["deploy/hetzner-up.sh"] --> create["hcloud creates the box<br/>(cloud-init installs Node 22 + firewall)"]
    create --> rdns["set reverse DNS → mail.example.com"]
    rdns --> rsync["rsync src/ to the box<br/>(no npm install; Node runs the .ts)"]
    rsync --> unit["write systemd unit with your domain/account"]
    unit --> start["systemctl enable --now mailserver"]
    start --> dns["you set A + MX records, then email yourself"]
```

This all runs **on your laptop** (a Unix shell; on Windows, use WSL2). Once, per
machine:

1. Clone the repo: `git clone https://github.com/jamie-lord/cutiemail && cd cutiemail`
   (the script rsyncs `src/` from your checkout to the box).
2. Create a [Hetzner Cloud](https://console.hetzner.com/) account and a read/write
   API token (a project's *Security → API tokens*), then install the
   [`hcloud` CLI](https://github.com/hetznercloud/cli) and authenticate it
   (`export HCLOUD_TOKEN=...`).
3. Upload an SSH key:
   `hcloud ssh-key create --name mykey --public-key-from-file ~/.ssh/id_ed25519.pub`.

Then, from the repo folder:

```sh
MAIL_DOMAIN=mail.example.com \
MAIL_PASS='a-real-passphrase' \
SSH_KEY_NAME=mykey \
  ./deploy/hetzner-up.sh
```

It creates one account, login **`you`** (set `MAIL_USER=somethingelse` to change
it), so your address is `you@mail.example.com`. Passing the password through the
environment is the throwaway-box trade-off; the manual path below uses `init`
instead, so a real deployment's unit file carries no password at all. The script
prints the two DNS records to set at your DNS host (an `A` and an `MX`, both
pointing at the box; at Cloudflare, set the A record to **DNS only**, see
[DNS](#dns)); reverse DNS is set for you. Watch mail arrive with
`ssh root@<ip> journalctl -fu mailserver`. When you're done:

```sh
./deploy/hetzner-down.sh          # deletes the box, billing stops
```

The rest of this document is the manual reference behind those scripts. Read on
if you want to do it by hand or on another provider.

## What you need

- A small Linux server with a **public, static IP** and **port 25 reachable both
  ways**. Many home ISPs and some cheap VPS providers block port 25, so check
  first, because without it you can neither receive nor relay. How to check,
  from the box once you have it: outbound is
  `nc -vz gmail-smtp-in.l.google.com 25` (a `succeeded` means open; cloud
  providers like Hetzner/AWS/DigitalOcean block outbound 25 on new accounts
  until you request it). Inbound is best checked later from another network
  (`nc -vz <your-box-ip> 25` from home) once the daemon is listening.
- A domain you control DNS for. This guide uses `mail.example.com` as both the
  hostname and the mail domain (so your address is `you@mail.example.com`). That
  keeps every name consistent, which matters for deliverability. See the
  [double-duty note](#known-limitations) on why one name is used for both.
- Node ≥ 22.18 and the repo on the box. There is no build and nothing else to
  install, but note the Node in Debian/Ubuntu's own `apt` archive is **too old**;
  install from [NodeSource](https://github.com/nodesource/distributions), which
  also lands it at `/usr/bin/node` (the path the unit's `ExecStart` uses; an
  `nvm`/`snap` install puts `node` elsewhere, so adjust `ExecStart` accordingly):

  ```sh
  # on the box, as root (or prefix sudo):
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git
  node --version                      # v22.18.0 or newer

  # the code, somewhere stable: the unit uses /opt/mailserver as its WorkingDirectory
  sudo git clone https://github.com/jamie-lord/cutiemail /opt/mailserver
  cd /opt/mailserver                  # every `node src/main.ts …` in this guide runs from here
  ```

  On a distro without a `mail` system user (it exists out of the box on
  Debian/Ubuntu), create one for the daemon:

  ```sh
  sudo useradd --system --user-group --home-dir /var/lib/mailserver --shell /usr/sbin/nologin mail
  ```

**Prepare the box first.** Create the data directory owned by the user the daemon runs as (the
unit below uses `mail`, which already exists on Debian/Ubuntu; create a system user otherwise),
and open the firewall. Do this **before** the DNS/`setup` step, which writes the DKIM key into
`/var/lib/mailserver/dkim/`:

```sh
# data + secrets directories, owned by the daemon's user, owner-only
sudo install -d -o mail -g mail -m 700 /var/lib/mailserver /var/lib/mailserver/tls /var/lib/mailserver/dkim

# open the ports (host firewall). Also check your PROVIDER's cloud firewall: many block
# inbound 25 by default, and `doctor` only tests OUTBOUND 25, so blocked inbound is silent.
sudo ufw allow 22/tcp && sudo ufw allow 25/tcp && sudo ufw allow 587/tcp && sudo ufw allow 993/tcp
# add 80/tcp if you use certbot's standalone HTTP challenge (needed at renewal too, not just issuance)
sudo ufw enable   # rules do nothing until the firewall is on; 22/tcp is already allowed above
```

> **Run every CLI command as the daemon's user** (`sudo -u mail node src/main.ts …`). The CLI
> creates files `0600` owned by whoever runs it (`UMask=0077`); a `control.db` or DKIM key created
> by `root` is `root:root` and the `mail`-user daemon gets a permission error at boot. This applies
> to `init`, `setup`, `account`, and `backup` alike.

> One cosmetic thing to expect: every `node src/main.ts …` command may print a harmless
> `ExperimentalWarning: SQLite is an experimental feature` line. That's Node's own notice about
> its built-in SQLite, not a problem with your setup. The npm scripts and the systemd unit
> silence it with `--disable-warning=ExperimentalWarning`; feel free to ignore it elsewhere.

## Running it in a container

If you deploy in containers rather than on bare-metal systemd, the repo ships a `Dockerfile`
and `docker-compose.yml` at the root ([ADR 0020](decisions/0020-container-image.md)). Because the
project has zero runtime dependencies and no build step, the image is only the Node runtime plus
`src/`, nothing to compile.

The first run has a strict order, because the daemon refuses to start without a real
certificate on a public bind **and** refuses to start with no accounts:

```sh
git clone https://github.com/jamie-lord/cutiemail && cd cutiemail

# 1. the certificate: the compose file mounts ./tls (read-only) into the container
mkdir tls
cp /path/to/fullchain.pem tls/cert.pem
cp /path/to/privkey.pem   tls/key.pem

# 2. edit docker-compose.yml: set MAIL_DOMAIN to your real name

# 3. your account: BEFORE anything is listening (hidden password prompt)
docker compose run --rm mail init you

# 4. the DKIM key + the exact DNS records to publish
docker compose run --rm mail setup

# 5. up, and watch the per-message + auth-failure trail
docker compose up -d
docker compose logs -f
```

**Just trying it locally?** The real-certificate requirement is there to stop you serving
the repo's public dev key on a public bind; it isn't in your way on a throwaway local run.
Two ways past it: set `MAIL_ALLOW_DEV_CERT: 1` in the environment to serve the bundled
self-signed dev cert (your client will warn about it, and the same public-key caveat applies, so
never do this where anyone outside can reach the box), or mint your own self-signed cert into
`./tls` in one line:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout tls/key.pem -out tls/cert.pem -days 365 -subj "/CN=$MAIL_DOMAIN"
```

Let's Encrypt (step 1 above) stays the production answer; these are for a local kick of the tyres.

One named volume (`/data`) holds every database and the DKIM key; the container binds the
unprivileged ports internally and maps them to 25/587/993 on the host, so nothing inside needs
a privileged-port capability. If a step is skipped the daemon says so instead of guessing: a
missing certificate or a zero-account registry each fail the boot with a message naming the fix
(there is **no** `demo`/`demo` fallback on a public bind; that convenience account is seeded on
loopback dev runs only). The rest of this guide (DNS, TLS renewal, backups, the account CLI)
applies unchanged; prefix day-2 CLI commands with `docker compose exec mail`, e.g.
`docker compose exec mail node src/main.ts selftest you`.

## DNS

The A and MX get mail flowing; PTR + the SPF/DKIM/DMARC trifecta are what earn a
receiver's trust and keep you out of the spam folder.

**You don't have to assemble these by hand.** The server generates them from its
own configuration, including deriving the DKIM public key from the private key
(generating one first if none exists). Give the DKIM key a **stable path** and run
`setup` as the daemon's user, so the daemon later signs with the *same* key the
published record verifies (without `MAIL_DKIM_KEY`, `setup` writes `dkim-<selector>.key`
into the current directory, a moving target, and re-running from elsewhere would mint a
second key that no longer matches DNS):

```sh
sudo -u mail env MAIL_DOMAIN=mail.example.com \
  MAIL_DKIM_KEY=/var/lib/mailserver/dkim/mail.key MAIL_DKIM_SELECTOR=s1 \
  node src/main.ts setup --ip <your-ip>
```

The daemon signs outbound mail **only when both `MAIL_DKIM_KEY` and `MAIL_DKIM_SELECTOR` are set**.
Set the same two values in the unit (below), or mail goes out unsigned (SPF-only) and big
receivers spam-folder it.

`setup` prints every record below as annotated, copy-pasteable zone lines. Re-run it any
time to reprint them from the existing key (the output is deterministic, so you can
diff it against what you actually published). And once the records are in, verify
the whole deployment (live DNS, reverse DNS, SPF evaluation, DKIM key match, the
certificate, and whether your provider allows outbound port 25) with:

```sh
# doctor reads the same env the daemon does: MAIL_DOMAIN is required, and the DKIM-match
# and certificate checks only run when the DKIM/TLS vars are present. Give it the deployment's
# environment (easiest: run it on the box with the unit's values). Add
# MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem once the certificate exists (the TLS
# section below). Pointing it at a file that isn't there yet aborts the whole run.
sudo -u mail env MAIL_DOMAIN=mail.example.com \
  MAIL_DKIM_KEY=/var/lib/mailserver/dkim/mail.key MAIL_DKIM_SELECTOR=s1 \
  node src/main.ts doctor
```

By default `doctor`'s outbound-25 probe dials `gmail.com`'s MX; use `--probe <domain>` to dial
a different one, or `--skip-dial` to skip it (e.g. offline). `doctor` checks the *outside* (DNS,
cert, outbound 25). Once the daemon is running, prove the
*mail path itself* (authenticated submission, local delivery, IMAP read-back) with
`node src/main.ts selftest <login>` (below). Note that `doctor` does **not** test *inbound* port 25
reachability from the internet; see the firewall note under [What you need](#what-you-need).

It exits 1 on any failure, so it works as a cron'd health check; re-run it whenever
deliverability "suddenly" changes, because the usual cause is drift in exactly the
things it checks (an expired certificate, a changed IP, a lost PTR). Two things it
does **not** check: it refuses the literal placeholder `mail.example.com` (it has no
real DNS), so substitute your real domain as everywhere in this guide; and it does not
test whether your IP has landed on a blocklist (Spamhaus, Barracuda, and the like), so
if DNS, PTR, and cert all come back green but mail is suddenly rejected or spam-foldered,
check the IP against the major blocklists by hand (see
[Known limitations](#known-limitations)). The table explains what each record is *for*:

One warning that outranks the table: **if your DNS host can proxy traffic (Cloudflare's
orange cloud), turn it OFF for the A record**. Set it to *DNS only*. Mail protocols
cannot pass through an HTTP proxy: a proxied record makes port 25/587/993 unreachable
and points SPF/PTR at the proxy's IPs instead of yours, and nothing in the resulting
failures says why. Cloudflare's default for a new A record is *proxied*.

| Record | Name | Value | Why |
|---|---|---|---|
| **A** | `mail.example.com` | your server's IP (**DNS only**, never proxied) | where the host lives |
| **MX** | `mail.example.com` | `10 mail.example.com` | tells senders to deliver here |
| **PTR** (reverse DNS) | your IP | `mail.example.com` | set at your VPS provider; Gmail checks the connecting IP resolves back to its HELO name |
| **TXT (SPF)** | `mail.example.com` | `v=spf1 ip4:<your-ip> -all` | authorises *this host's* IP to send for the domain |
| **TXT (DKIM)** | `<selector>._domainkey.mail.example.com` | `v=DKIM1; k=rsa; p=<pubkey>` | the public key that verifies your DKIM signatures (see Running it) |
| **TXT (DMARC)** | `_dmarc.mail.example.com` | `v=DMARC1; p=quarantine` | the policy receivers apply. `setup` emits `p=quarantine` by default; pass `--dmarc-policy none` while you're still testing (monitor only), then tighten. (No `rua=` is generated; add one yourself if you want aggregate reports.) |

All three align because the From domain, the DKIM `d=`, and the SPF domain are the
same name, so a receiver checking DMARC sees SPF *and* DKIM pass for the sending
domain. That is what receivers require before they will even *consider* your
reputation: a prerequisite for the inbox, not a guarantee of it (see
[Known limitations](#known-limitations) on why passing auth is only half the job).

`setup` publishes `p=quarantine`. If you'd rather ease in, start at `p=none`
(`--dmarc-policy none`) while you confirm SPF and DKIM align (add a `rua=`
address to the record and read the aggregate reports receivers send back), then tighten
to `quarantine`/`reject` once the reports show clean passes and you trust your setup.

`setup` also prints an **optional inbound MTA-STS** section: the exact policy file to
host at `https://mta-sts.<domain>/.well-known/mta-sts.txt` (any static HTTPS host; this
server deliberately speaks no HTTP, ADR 0013) plus the `_mta-sts` TXT record, so senders
that honour MTA-STS can refuse to deliver your mail over anything but validated TLS.

## Running it

The daemon is configured entirely by environment variables. There is no config file, and the
SQLite databases are created on first run:

| Variable | For a real deployment |
|---|---|
| `MAIL_DOMAIN` | `mail.example.com`, your hostname *and* mail domain |
| `MAIL_HOST` | `0.0.0.0`, bind all interfaces, not just loopback |
| `MAIL_SMTP_PORT` / `MAIL_SUBMISSION_PORT` / `MAIL_IMAP_PORT` | `25` / `587` / `993` |
| `MAIL_USER` / `MAIL_PASS` | the **primary** account, used to *create* it on first boot; after that the registry is the source of truth and a changed env password is ignored with a warning (ADR 0012) |
| `MAIL_ACCOUNTS` | additional accounts as `"user:pass,user2:pass2"`, create-only, same rule. Every entry must contain a colon: one that doesn't (a stray trailing comma, or a password containing one) **fails the boot** naming the entry, rather than being silently dropped. An entry whose login an alias already claims, or which collides case-insensitively with an existing login, is skipped with a logged warning. The clean way to manage accounts is `node src/main.ts account` (below) |
| `MAIL_CONTROL_DB` | `/var/lib/mailserver/control.db`, the control database (account registry + outbound queue) |
| `MAIL_DB` | only used **with** `MAIL_USER` (legacy bootstrap). Under the recommended `init` flow, each account's mailbox is `mail-<login>.db` beside the control DB; leave `MAIL_DB` unset |
| `MAIL_TLS_CERT` / `MAIL_TLS_KEY` | paths to a real certificate (Let's Encrypt) |
| `MAIL_DKIM_KEY` / `MAIL_DKIM_SELECTOR` | PEM key path + selector to sign outbound (see below) |
| `MAIL_TRUSTED_ARC_SEALERS` | comma-separated forwarder domains whose valid ARC chain may rescue a DMARC failure to the inbox (e.g. a mailing list you subscribe to); omit for none |
| `MAIL_MAX_SIZE` | max accepted message size in octets (default 25 MiB) |

Each account's mailbox lives in its own SQLite file; a shared control database holds the SCRAM
credential registry (which stores only the derived StoredKey/ServerKey, never the password) and the
persistent outbound queue. Inbound mail is delivered into the addressed account's mailbox; a
recipient that isn't a known local account is rejected at `RCPT` (no catch-all, no backscatter).

**Recommended first run: `init` (no password in the environment).** Instead of putting a
password in the unit file, create the primary account with a hidden prompt that writes SCRAM
straight to the registry, so no plaintext password ever lands in the unit or
`/proc/<pid>/environ`:

```sh
sudo -u mail env MAIL_DOMAIN=mail.example.com \
  node src/main.ts init you --db /var/lib/mailserver/control.db
# prompts (twice, hidden) for the password, then prints a passwordless unit to run
```

Pass `MAIL_DOMAIN` here even though `init` doesn't strictly need it: the unit it prints
back embeds whatever domain it sees, so without it the suggested unit carries the
placeholder `MAIL_DOMAIN=mail.example.com`. Either set it as above, or replace that line
with your real domain before you install the unit.

`init` is first-run-only (it refuses once any account exists; use `account add` after), and
it is not optional in this flow: on a public bind the daemon **refuses to boot with zero
accounts** (the loopback-only `demo`/`demo` dev convenience never fires on a real server), so
run `init` before the unit is ever started. The `MAIL_USER`/`MAIL_PASS` env vars remain as a
create-only bootstrap for dev (`npm start`) and unattended provisioning, but a production unit
should carry **no password at all**; `doctor` and the daemon both warn when
`MAIL_PASS`/`MAIL_ACCOUNTS` are present but redundant.

Passwords must be at least 8 characters (the NIST SP 800-63B floor); `init`, `account add`,
and `account set-password` refuse a shorter one. A weak password seeded through the
deprecated `MAIL_PASS`/`MAIL_ACCOUNTS` env path is only *warned* about (a boot must not fail
on it). Provision real credentials with `init`/`account` instead.

Day-2 account management (adding people, app passwords, aliases) is all one CLI and is
covered in [Day-2 operations](#day-2-operations-accounts-backups-the-queue) below; nothing
there is needed to get the server live.

What the running server does, end to end: it **receives** on 25 (stamping a
`Received:` trace line, rejecting oversized messages and mail loops), authenticates
every sender (**SPF + DKIM + DMARC**, aligned over the full Public Suffix List, plus
**ARC** validation) and records the result in `Authentication-Results`, then **enforces**
DMARC by filing a `p=quarantine`/`p=reject` failure into the recipient's Junk folder
(never a hard reject; a trusted ARC sealer can rescue it). It **serves** the mailbox on 993
with the IMAP surface a real client needs (multiple folders, `IDLE` for instant new-mail,
`UIDPLUS`, `CONDSTORE`/`QRESYNC`), and **sends** what's submitted on 587 by signing it (DKIM),
stamping `Received:`, and relaying to the recipient's MX over STARTTLS (opportunistic, or
MTA-STS-enforced when the destination publishes a policy), with a persistent retry queue behind it.

### TLS: getting the certificate to the daemon, and keeping it fresh

Do this **before** starting the daemon. The unit below points at
`/var/lib/mailserver/tls/`, and the daemon exits at boot (naming the missing
file) if the certificate isn't there yet. The daemon runs as `mail` and cannot
read root-only `/etc/letsencrypt/live/`, so you point it at a copy. Issue with
the standalone authenticator (port 80 must be open in the firewall; nothing
else may bind it), copy, and (the part that prevents a silent outage two
renewals later) install a **deploy hook** so every renewal propagates the new
cert and restarts the daemon. All of this is root's work, hence `sudo -i`:

```sh
sudo apt-get install -y certbot
sudo -i    # a root shell for the rest of this block

certbot certonly --standalone -d mail.example.com
install -o mail -g mail -m 600 /etc/letsencrypt/live/mail.example.com/fullchain.pem /var/lib/mailserver/tls/cert.pem
install -o mail -g mail -m 600 /etc/letsencrypt/live/mail.example.com/privkey.pem  /var/lib/mailserver/tls/key.pem

cat > /etc/letsencrypt/renewal-hooks/deploy/mailserver-tls.sh <<'EOF'
#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in */mail.example.com) ;; *) exit 0 ;; esac
install -o mail -g mail -m 600 "$RENEWED_LINEAGE/fullchain.pem" /var/lib/mailserver/tls/cert.pem
install -o mail -g mail -m 600 "$RENEWED_LINEAGE/privkey.pem"  /var/lib/mailserver/tls/key.pem
systemctl restart mailserver
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/mailserver-tls.sh
certbot renew --dry-run   # proves the renewal path works
exit       # leave the root shell
```

Serve `fullchain.pem` (not `cert.pem`): clients need the intermediate. Without
the hook, certbot renews into `/etc/letsencrypt` while the daemon keeps serving
the stale copy until it expires ~30 days later.

The apt certbot installs a systemd timer that runs `renew` twice daily and fires the
deploy hook above when a cert is renewed; no separate cron needed. Confirm it's
active with `systemctl list-timers certbot.timer`; some snap and pip installs don't add
one, in which case add your own timer or cron entry running `certbot renew`.

### The systemd unit

Ports 25/587/993 are privileged (< 1024), so the process needs the capability to
bind them. The clean way is a systemd unit that grants exactly that and nothing
else, no running as root:

```ini
# /etc/systemd/system/mailserver.service
[Unit]
Description=mail server
After=network.target

[Service]
Type=simple
User=mail
WorkingDirectory=/opt/mailserver
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.ts
Environment=MAIL_DOMAIN=mail.example.com
Environment=MAIL_HOST=0.0.0.0
Environment=MAIL_CONTROL_DB=/var/lib/mailserver/control.db
Environment=MAIL_SMTP_PORT=25 MAIL_SUBMISSION_PORT=587 MAIL_IMAP_PORT=993
# No MAIL_USER/MAIL_PASS: create the primary account with `init` (above), which writes
# SCRAM to the registry; the unit carries no password. (MAIL_USER/MAIL_PASS still work
# as a create-only bootstrap for dev, but the daemon warns when they linger unnecessarily.)
# No MAIL_DB either: it is only read alongside MAIL_USER. With `init`, each account's mailbox
# is mail-<login>.db beside the control DB, created automatically.
Environment=MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem
Environment=MAIL_TLS_KEY=/var/lib/mailserver/tls/key.pem
# DKIM signing: the same key + selector `setup` generated (see DNS). Omit these and outbound
# mail is unsigned (SPF-only) and gets spam-foldered:
Environment=MAIL_DKIM_KEY=/var/lib/mailserver/dkim/mail.key
Environment=MAIL_DKIM_SELECTOR=s1
# Bind privileged ports (25/587/993) without root, and nothing more:
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# Headroom for open mail DBs (~3 fds each) + one fd per IMAP connection; the 1024 default
# is a hard wall under load (docs/PERFORMANCE.md).
LimitNOFILE=65536
Restart=on-failure

# Defense-in-depth sandboxing (systemd-analyze security scores this unit ~1.6 / OK).
# MemoryDenyWriteExecute is deliberately OMITTED: the V8 JIT needs W+X memory and
# Node will not start with it. RestrictAddressFamilies keeps AF_INET/AF_INET6 (SMTP/
# IMAP + c-ares DNS) and AF_UNIX; verify outbound relay still works after any change.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mailserver
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
UMask=0077

[Install]
WantedBy=multi-user.target
```

The data directory is owner-only (`mode 700`, set in *Prepare the box* above). The daemon writes
each database `0600` and re-tightens every *registered* account's database to `0600` at boot (so
even a disabled account's mailbox can't linger world-readable), but the `700` directory is the
belt-and-braces that keeps a stray file unreachable by other local users in the first place.

Before starting it, make sure the earlier steps happened. The unit
depends on all three: the account (`init`), the DKIM key (`setup`), and the
certificate (TLS above). If one is missing the daemon exits with a message
naming the file or the fix, and `Restart=on-failure` means `systemctl status
mailserver` will show it retrying; `journalctl -u mailserver` has the reason.

`sudo systemctl enable --now mailserver`, then `journalctl -fu mailserver` to watch it. The daemon logs
one line per accepted inbound message (envelope, size, SPF/DKIM/DMARC verdicts, and which folder it
was filed to), one per accepted submission (with the queue id), each relay deferral with its remote
reason and next-attempt time, the final sent/bounced/gave-up outcome, and every failed
authentication with its source IP: the raw material for spotting a credential-stuffing run (there
is no built-in fail2ban integration; see [Known limitations](#known-limitations)). A transient
failure is retried on a backoff from the persistent SQLite queue (below); a `5xx` bounces at once.

A representative slice of that trail, one gloss each:

```text
inbound 4b2f: from=<alice@gmail.com> to=<you@mail.example.com> size=4213 dkim=pass spf=pass dmarc=pass filed=INBOX
    ^ accepted inbound: all three auth checks passed, delivered to the inbox
inbound e7a1: from=<spammer@evil.test> to=<you@mail.example.com> size=902 dkim=none spf=fail dmarc=fail filed=Junk
    ^ accepted but failing DMARC: filed to Junk, not rejected (a trusted ARC sealer could still rescue it)
submission 9c1d: user=you from=<you@mail.example.com> local=0 remote=1 queued=42 size=1876
    ^ accepted submission from an authenticated client: one remote recipient, enqueued as id 42
queue 42: deferred for 1 recipient(s) (attempt 2), 421 4.7.0 try again later; next attempt 2026-07-22T14:03:11.000Z
    ^ transient relay failure: retried on backoff from the persistent queue, not lost
queue 42 bob@example.net: bounced (gave up after 12 attempts)
    ^ delivery permanently gave up: sender gets a bounce, the bytes land in dead-letter
submission auth failed for "you" from 203.0.113.7
    ^ a failed login with its source IP (imap auth failed ... from ... is the IMAP-side equivalent)
```

### Verify it end to end

Two checks, in order. First `doctor` proves the *outside* (DNS, PTR, SPF, the DKIM key
match, certificate validity, outbound 25), now with the certificate in its environment
(unlike the pre-cert run in [DNS](#dns)):

```sh
sudo -u mail env MAIL_DOMAIN=mail.example.com \
  MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem \
  MAIL_DKIM_KEY=/var/lib/mailserver/dkim/mail.key MAIL_DKIM_SELECTOR=s1 \
  node src/main.ts doctor
```

Then `selftest` proves the *mail path itself*, before pointing a client at it: authenticated
submission, local delivery, and IMAP read-back, in one command against the running daemon
(it prompts for the account's password; both submission and IMAP authenticate as that login,
or it reads one line from stdin when piped):

```sh
sudo -u mail env MAIL_DOMAIN=mail.example.com MAIL_SUBMISSION_PORT=587 MAIL_IMAP_PORT=993 \
  node src/main.ts selftest you
```

A green run means the mail path is sound; a failure names the step that broke (auth, delivery, or
IMAP). If the daemon can't start at all, it prints a specific reason (a port already in use,
or a privileged port without the capability) rather than a stack trace.

`selftest` sends the account's password, so it refuses to authenticate against a server whose
greeting names a different domain than `MAIL_DOMAIN` — pass the same `MAIL_*` environment as the
daemon, as above, or it will dial the development defaults and stop. For the same reason it
validates the TLS certificate unless the target is loopback, where the bundled development
certificate cannot pass a hostname check anyway. If a test message you
sent from elsewhere seems to vanish, check the **Junk** folder and read its `Authentication-Results`
header: DMARC enforcement files a failing message there rather than the inbox (a common surprise
while DNS is still settling).

## Migrating your existing mail in

cutiemail speaks standard IMAP, so moving your existing mail in is a plain IMAP-to-IMAP copy with
an off-the-shelf tool; there's nothing bespoke to learn. [`imapsync`](https://imapsync.lamiral.info/)
is the usual choice:

```sh
imapsync \
  --host1 imap.gmail.com --user1 you@gmail.com --passfile1 gmail.pass --ssl1 \
  --host2 mail.example.com --user2 you --passfile2 cutie.pass --ssl2
```

Or, with no extra software: add both accounts in Thunderbird and drag folders from the old account
to the new one. Either way the copy is byte-exact and preserves each message's original date
(`INTERNALDATE`) and flags. One boundary: an individual message larger than `MAIL_MAX_SIZE`
(25 MiB default) is refused on `APPEND`. Raise `MAIL_MAX_SIZE` if your archive has very large
messages (it raises the SMTP and IMAP limits together).

## Cutting over a domain you already use

Moving a domain that already receives real mail (rather than a fresh subdomain) is a sequencing
problem. Do it in this order so nothing is lost in the window:

1. **Lower the TTL** on your current MX record to 300s a day ahead, so the switch propagates fast.
2. **Stand the box up fully under a subdomain first** (`mx.example.com`) and get `doctor` and
   `selftest` green there (DNS, TLS, DKIM, the mail path) while your real MX still serves the
   domain.
3. **Import first** (above), so your history is already present when you switch.
4. **Publish `--dmarc-policy none`** during the overlap so a misalignment quarantines nothing while
   you watch; tighten to `quarantine`/`reject` once `doctor` is clean and mail flows.
5. **Switch the MX** to the new box. A well-behaved sender that connects mid-switch and gets no
   answer **retries for days** (mail isn't lost, it's delayed), so a brief overlap is safe.
6. **Keep the old mailbox reachable** for a week or two before decommissioning; stragglers and
   slow-retrying senders trickle in after the cutover.

There is deliberately no backup-MX support (recorded in [the backlog](BACKLOG.md)): the
sender-retry behaviour above is what covers a short outage, so a second MX isn't needed at this
scale.

## Pointing your mail client at it

In Thunderbird (or any client), add an account for `you@mail.example.com`:

- **Incoming (IMAP):** `mail.example.com`, port `993`, SSL/TLS, your username +
  password.
- **Outgoing (SMTP):** `mail.example.com`, port `587`, STARTTLS, *same* username +
  password (auth required).
- **Username:** the account **login** (`you`), **not** the full email address
  `you@mail.example.com`. Clients pre-fill the address as the username; change it to the
  bare login or auth fails on both ports. Case does not matter — `You` and `YOU`
  authenticate the same account — but a login differing from an existing one *only* in
  case is refused at creation, because both would map to the same `mail-<login>.db`.

The daemon **refuses to boot** if you bind a non-loopback `MAIL_HOST` without a real
certificate (`MAIL_TLS_CERT`/`MAIL_TLS_KEY`): the bundled dev cert's private key is
committed to the repo, so serving it publicly would let anyone MITM your credential
ports. `deploy/hetzner-up.sh` generates a per-box self-signed cert (a fresh, private
key) so the box boots; a client still warns about self-signed, and a real Let's Encrypt
cert avoids the warning and is what outside senders' opportunistic TLS expects.
(`MAIL_ALLOW_DEV_CERT=1` forces the bundled dev cert onto a public interface, for a
deliberate throwaway test only, never in production.)

## Day-2 operations: accounts, backups, the queue

Everything here runs against the live server: no restarts, no downtime. Two standing rules
from earlier apply to every command: run them **as the daemon's user** (`sudo -u mail …`, so no
root-owned file ever blocks the daemon) and **from `/opt/mailserver`**.

> Every example passes `--db /var/lib/mailserver/control.db`. Set `MAIL_CONTROL_DB` in your
> shell (or rely on the unit's environment) to drop it. Without either, the CLI targets
> `./control.db` in the current directory, and a "no account" error there means you're pointed
> at the wrong database, not that the account is gone (the error names the path it searched).

**Managing accounts.** The CLI prompts for the password; when piped, it reads one line from
stdin, never argv, which is visible in `ps`:

```sh
sudo -u mail node src/main.ts account add anna --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts account set-password anna --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts account list --db /var/lib/mailserver/control.db
```

The running daemon sees changes immediately (auth reads the registry per attempt), no
restart. There is deliberately no `remove`: `disable` refuses auth and delivery without
touching the user's mailbox database; deleting mail is an explicit `rm` of that file,
never a management-verb side effect (ADR 0012).

**What containment actually cuts.** `disable` and `set-password` both take effect on
*already-established* IMAP sessions, not only on the next login: the daemon re-checks every
live session on a short timer and drops any whose account has been disabled or whose
credential has been replaced (`* BYE`). That matters because an attacker's session is most
likely to be parked in IDLE, which sends no commands to be refused, and because a session can
hold a socket open indefinitely without ever completing one. Mail the account has *already*
submitted stays in the outbound queue — use `queue cancel` if that matters.

**App-specific passwords** (ADR 0017) are a revocable per-device credential, so a lost phone
doesn't mean rotating your one password everywhere. Each is server-generated and shown once:

```sh
sudo -u mail node src/main.ts account app-password add you phone --db /var/lib/mailserver/control.db  # prints a strong secret ONCE
sudo -u mail node src/main.ts account app-password list you --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts account app-password remove you phone --db /var/lib/mailserver/control.db  # revoke; honoured live
```

Use the printed secret as this account's password on one device. Your primary password still
works everywhere; the recommended practice is to put app passwords on your devices and keep the
primary for `account` management only, so no device ever holds your primary. A revoked app
password stops authenticating immediately, and disabling the account disables all of them.

**Aliases and `+tag` subaddressing.** An account can answer to more than one address
(ADR 0014). An alias is a second address whose mail lands in the same mailbox: it adds no
database (a user is still one file), and you can't log in as one. Subaddressing is on by
default: `you+anything@your.domain` delivers to `you` with no setup, handy for per-service
filtering.

```sh
sudo -u mail node src/main.ts account alias add you sales --db /var/lib/mailserver/control.db  # sales@your.domain → "you"
sudo -u mail node src/main.ts account alias list --db /var/lib/mailserver/control.db           # every alias and its owner
sudo -u mail node src/main.ts account alias remove sales --db /var/lib/mailserver/control.db
```

Give the local-part only (`sales`, not `sales@your.domain`). An address is a login *or* an
alias, never both; unknown addresses are still refused at RCPT (no catch-all). New aliases
receive immediately, no restart.

**`postmaster` always works, and lands in your first account.** RFC 5321 §4.5.1 makes this a
MUST rather than a convention: every mail server has to accept `postmaster@your.domain`, and
also the bare `RCPT TO:<postmaster>` with no domain at all, as a case-insensitive name. So it
does — unless something else claims the name, it resolves to your first enabled account, and the
startup banner says which one:

```text
  postmaster: <postmaster@your.domain> and the bare <postmaster> deliver to you (RFC 5321 §4.5.1).
```

To send it somewhere else, make an alias and it wins outright — the built-in behaviour is only a
floor under everything else, so an alias (or a real account named `postmaster`) takes precedence:

```sh
sudo -u mail node src/main.ts account alias add admin postmaster --db /var/lib/mailserver/control.db
```

What you cannot do is turn it off. That is deliberate: it is where other postmasters write when
your server misbehaves, where DMARC and abuse reports go, and where a remote operator looks before
blocking you. See [ADR 0026](decisions/0026-reserved-postmaster-mailbox.md).

**Sending as an alias.** You can also *send* as any address you own (your login, an alias, or
a `+tag` subaddress). Submission enforces this: your client's `From` (and the envelope sender)
must resolve to your account, on your domain, or the message is refused `550` (ADR 0015). Set
your mail client's identity/From to the alias (for example configure a `sales@your.domain`
identity in Thunderbird) and mail sends DKIM-signed as that address. You cannot send as
another account's address or a foreign domain; that is the point.

**Backups.** The whole server's state is the control database plus one mailbox database
per user, so a backup is one command (safe while the daemon runs: it uses SQLite's
`VACUUM INTO`, a transactionally consistent snapshot; a bare `cp` of a live WAL database
is *not* safe):

```sh
sudo install -d -o mail -g mail -m 700 /backups   # once
sudo -u mail node src/main.ts backup /backups/mail-$(date +%F) --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts verify /backups/mail-$(date +%F)   # a backup you haven't verified is a hope
```

`verify` is strictly read-only and checks both file integrity and the store invariants
(UID monotonicity, the live/expunged partition, the queue/dead-letter exclusivity). Honest
boundary: SQLite pages carry no checksums, so a bit flipped inside a message blob on disk
is invisible to it; media-level assurance is the filesystem's job (ZFS/btrfs/restic).

For an on-demand check of the **live** store (not a snapshot), `doctor --store` runs
`PRAGMA quick_check` over the control database and every mailbox database it references. It is
read-only and safe against a running daemon (WAL readers don't block the writer), so it answers
"are my databases still sound on disk" without a stop:

```sh
sudo -u mail node src/main.ts doctor --store --db /var/lib/mailserver/control.db
```

It exits non-zero and prints the offending database if any `quick_check` fails. This is the
b-tree-structure complement to `verify`'s invariant checks; neither sees a bit flipped inside a
message blob (that stays the filesystem's job).

A backup is the **complete mail store plus the credential registry, in plaintext SQLite**: the
SCRAM records aren't reversible to passwords, but message bodies are in the clear. Encrypt it
before it leaves the box (`age`, `restic`, or your backup tool's own encryption).

**Make it nightly.** The one command above is easy to wire into a timer so backups happen
whether or not you remember. A cron entry that snapshots, verifies, prunes to a retention window,
and ships an encrypted copy off-box:

```sh
# /etc/cron.d/mailserver-backup: 03:15 nightly, as the daemon's user
15 3 * * * mail cd /opt/mailserver && dest=/backups/mail-$(date +\%F) && \
  node --disable-warning=ExperimentalWarning src/main.ts backup "$dest" --db /var/lib/mailserver/control.db && \
  node --disable-warning=ExperimentalWarning src/main.ts verify "$dest" && \
  age -r <your-age-recipient> "$dest"/*.db && rclone copy "$dest" remote:mail-backups/ && \
  find /backups -maxdepth 1 -name 'mail-*' -mtime +14 -exec rm -rf {} +
```

Swap `age`/`rclone` for whatever your backup tool uses; the load-bearing parts are `backup`
then `verify` (never trust an unverified snapshot), a retention prune (`-mtime +14` keeps two
weeks), and getting an *encrypted* copy off the box: a backup that only lives on the box it's
protecting is no backup. A systemd timer + oneshot service does the same job if you prefer it to
cron.

**Restoring from a backup.** Stop the daemon, **delete any stale WAL/SHM sidecars** in the data
directory, copy the snapshot files over the live ones, restart, and confirm:

```sh
sudo systemctl stop mailserver
# Delete stale sidecars FIRST. A -wal / -shm left by an uncleanly-stopped daemon replays into
# whatever .db sits beside it on the next open, resurrecting state the snapshot never held. The
# snapshot is self-contained (VACUUM INTO writes a checkpointed db with no sidecar), so remove
# them before copying.
sudo rm -f /var/lib/mailserver/*.db-wal /var/lib/mailserver/*.db-shm
sudo cp /backups/mail-2026-07-21/*.db /var/lib/mailserver/     # control.db + every mail-<login>.db
sudo chown mail:mail /var/lib/mailserver/*.db
sudo systemctl start mailserver
sudo -u mail node src/main.ts verify /var/lib/mailserver        # integrity + invariants
sudo -u mail env MAIL_DOMAIN=mail.example.com MAIL_SUBMISSION_PORT=587 MAIL_IMAP_PORT=993 \
  node src/main.ts selftest you                                 # the mail path end to end
```

`backup` copies the databases whole, so a restore is putting them back. Restore to the
**original data directory**: the control registry records each account's mailbox as an
*absolute* `mail-<login>.db` path, so a snapshot dropped somewhere else leaves the daemon
opening the old locations (or none). An account present in the registry whose mailbox file is
missing from the backup comes back as an empty mailbox (its credentials and aliases are intact)
rather than failing the restore.

**"Did my mail actually leave?"** The outbound queue (transient failures retry on an
exponential backoff for ~5 days before giving up; the queue survives a restart) and the
dead-letter store (messages delivery permanently gave up on, retained instead of dropped)
are inspectable:

```sh
sudo -u mail node src/main.ts queue list --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts queue retry <id> --db /var/lib/mailserver/control.db   # skip the backoff after fixing a fault (--all for every message)
sudo -u mail node src/main.ts queue cancel <id> --db /var/lib/mailserver/control.db  # pull a message (retained in dead-letter, never discarded)
sudo -u mail node src/main.ts dead-letter list --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts dead-letter show <id> --raw --db /var/lib/mailserver/control.db > message.eml   # the retained bytes, replayable
sudo -u mail node src/main.ts dead-letter requeue <id> --db /var/lib/mailserver/control.db                    # try delivery again
sudo -u mail node src/main.ts mail list you --db /var/lib/mailserver/control.db      # read a delivered mailbox without an IMAP client
```

A permanently-failed message always does two things: the sender gets a `multipart/report`
bounce, and the bytes land in the dead-letter store until an explicit `purge`.

## Keeping an eye on it

A single-box mail server doesn't need a metrics stack: a cron'd `doctor` (a health check that
exits non-zero on drift, [above](#dns)) plus a couple of threshold one-liners cover the things
that go wrong. Three worth wiring up:

```sh
# queue not draining: alert if more than N messages are stuck waiting to relay
[ "$(sudo -u mail node src/main.ts queue list --db /var/lib/mailserver/control.db | wc -l)" -gt 50 ] \
  && echo "mail queue backing up" | mail -s "queue depth" you@elsewhere.example

# anything in dead-letter is delivery that permanently gave up; you want to know
[ "$(sudo -u mail node src/main.ts dead-letter list --db /var/lib/mailserver/control.db | wc -l)" -gt 0 ] \
  && echo "dead-letter is non-empty" | mail -s "dead-letter" you@elsewhere.example

# free space on the data volume: the store grows with the mailboxes; alert under ~10%
df --output=pcent /var/lib/mailserver | tail -1 | tr -dc 0-9 | awk '$1 > 90 { print "disk >90% on mail volume" }'
```

Two more habits, no tooling needed: **watch free disk** on the data volume (a full disk makes
inbound delivery fail *transiently*, so senders retry rather than lose mail; see
[Performance](PERFORMANCE.md#the-ceilings); but you don't want to run there), and **check the
IP against the major blocklists periodically** (Spamhaus, Barracuda, and mxtoolbox's combined
lookup): `doctor` can't see a blocklisting, and a fresh cloud IP can land on one without warning.

## Keeping itself up to date

Self-hosted software rots. It gets deployed, it works, and then it sits — unpatched, drifting away
from the internet around it — because upgrading is a chore nobody schedules. cutiemail can keep
itself current instead. The design and its reasoning are in
[ADR 0025](decisions/0025-self-update.md); this is how to run it.

It ships **reporting-only**. It will tell you a new version is available and that it verified
cleanly; it will not switch until you say so. Turn switching on once you have watched it be right a
few times.

### The layout it needs

The updater cannot manage a deployment installed as a flat directory, because there is nothing to
switch. The code lives under a version store instead:

```text
/opt/mailserver/
  current -> versions/<commit>     the ONE thing that says what runs
  versions/<commit>/               a verified checkout, never modified after it lands
```

and the unit runs `/opt/mailserver/current/src/main.ts`. A cutover is then a `rename(2)` over the
symlink plus a restart, and a rollback is the same rename in reverse.

**The daemon must not own that directory.** It is the internet-facing part; if a remote compromise
of it could rewrite what runs next, the compromise becomes permanent. So the code belongs to a
separate `mailupd` user and the mail user only ever reads it:

```sh
sudo useradd --system --home-dir /opt/mailserver --shell /usr/sbin/nologin mailupd
sudo chown -R mailupd:mailupd /opt/mailserver
sudo chmod -R u=rwX,go=rX /opt/mailserver
# the updater snapshots the databases, so it needs to read them — group access, not ownership
sudo usermod -a -G mail mailupd
sudo chown -R mail:mail /var/lib/mailserver
sudo chmod 770 /var/lib/mailserver
sudo chmod 660 /var/lib/mailserver/*.db*
```

**The group is the access-control decision, and it is the only one.** The daemon sets its databases
to `0660` — owner and group, never world — and re-applies that on every open. So whoever is in the
data group can read the mail and the credential material, and nobody else can. Check it with
`getent group mail`: it should contain the updater and nothing else. On a deployment with no
updater the group has one member, and `0660` is `0600` in effect.

Do not try to grant this with an ACL. The daemon's `chmod` resets an ACL's mask to nothing on every
open, so the grant survives exactly until the next restart — which a cutover always performs, making
the failure both silent and delayed. The pre-flight passes once and then fails forever with
`unable to open database file`, blaming your data.

The directory is group-**writable** because a failed cutover restores the databases from its
pre-cutover snapshot, which means creating files there. That path runs when something has already
gone wrong, which is the worst moment to meet a permission error.

The updater needs write access as well as read: the cutover probe mints an app password immediately
before checking and revokes it immediately after, so an update is confirmed by a real message
through authenticated submission rather than by the process merely being up. That is not the
privilege it appears to be — whoever chooses the code the mail server runs can already read all the
mail. The separation that does the work is the one above: **the daemon cannot write its own code.**

The updater also needs to restart the daemon. Grant it that for **one unit and three verbs**, so
it never has to run as root:

```sh
# /etc/polkit-1/rules.d/50-mailserver-update.rules
polkit.addRule(function (action, subject) {
  if (action.id === 'org.freedesktop.systemd1.manage-units'
      && subject.user === 'mailupd'
      && action.lookup('unit') === 'mailserver.service'
      && ['start', 'stop', 'restart'].indexOf(action.lookup('verb')) !== -1) {
    return polkit.Result.YES;
  }
});
```

### Telling it what you are running

Once, before anything else:

```sh
sudo -u mailupd env MAIL_UPDATE_ROOT=/opt/mailserver \
  node /opt/mailserver/current/src/update/main.ts adopt "$(git -C /opt/mailserver/current rev-parse HEAD)"
```

This records the baseline every later update is measured against. It **fetches** that commit from
the repository rather than trusting the files on disk, so a wrong or abbreviated id fails here
instead of quietly poisoning every later comparison.

### What a check actually does

`node src/update/main.ts check` fetches the branch tip and puts it through a ladder. Any failure at
any rung abandons the update and leaves the running version untouched.

- **Provenance.** The candidate must have the commit you are running in its ancestry, so nobody can
  move a deployment backwards and a force-push over deployed history refuses rather than applying.
  It must also be at least `MAIL_UPDATE_BAKE_DAYS` old (default 3), so a mistake merged to the
  branch has a window to be noticed before it reaches you.
- **Integrity.** Every object hashes to the id it was fetched as; every file name in the tree passes
  an allow-list. A malformed download is "no update available", never a partial checkout.
- **Shape.** Including whether the new version needs a newer Node than this machine has — which is
  otherwise discovered *after* the switch, as a daemon that will not start.
- **That it runs on this machine**: every module imported under the Node actually installed. Not
  the test suite — that re-answers what CI settled, and on a small box it cannot finish.
- **An isolated boot**, plus the SMTP conformance corpus run against both the candidate and the
  version you are running. Only findings the candidate *introduces* fail it; refusing an update over
  a gap your current version already has would pin you on the version that has it.
- **Your data.** `VACUUM INTO` snapshots of every database, and the candidate booted against
  *those copies with your real configuration* on loopback ports. This answers the questions that
  actually break deployments: does the migration work at your size, **how long does it take** (that
  is your cutover downtime, measured before you commit to it), does your configuration still
  satisfy the new version, and are all your accounts, mailboxes and messages still there afterwards,
  byte for byte. Then a real message through submission, delivery and IMAP read-back against a real
  mailbox.

The candidate is forced into `MAIL_OUTBOUND=hold` for all of that, because the snapshot contains
your outbound queue and a candidate booted in delivery mode would relay every queued message a
second time. It never binds 25, 587 or 993. The snapshots are destroyed whatever the outcome.

### Letting it switch

```sh
# by hand, once you want to
sudo -u mailupd env MAIL_UPDATE_ROOT=/opt/mailserver ... node .../src/update/main.ts apply

# or unattended: change the timer unit's mode and reload
Environment=MAIL_UPDATE_MODE=apply
```

A cutover drains before it switches: `systemctl stop` lets an in-flight `DATA` handler finish and
reply, and the relay tick complete. If that does not finish inside `MAIL_UPDATE_DRAIN_SECONDS` the
cutover is **abandoned rather than forced** — an update can wait, an interrupted delivery cannot be
undone. After the switch the new version has to pass a live mail-path probe and stay healthy for
`MAIL_UPDATE_PROBE_SECONDS`, or it is reverted automatically. If its migration moved the schema
forward, the pre-cutover snapshot is restored too, because the older version cannot read a migrated
database. Nothing is deleted in a revert: the failed version's databases are kept aside with a
`.failed-<timestamp>` suffix.

### Watching it

```sh
sudo -u mailupd env MAIL_UPDATE_ROOT=/opt/mailserver node .../src/update/main.ts status
```

The line to care about is **staleness**. If checks stop reaching the repository — a firewall change,
a DNS problem, an expired credential — nothing else would tell you: the deployment simply stops
being updated and looks fine. `status` exits non-zero once it has been longer than
`MAIL_UPDATE_STALE_DAYS` (default 30), which is the same rot the whole mechanism exists to prevent,
arriving through the mechanism itself.

`reset` clears a stuck cutover phase without touching what is running, for the rare case where an
operator has to be the one deciding.

### What this does not fix

Updating is not the same as staying healthy. Node going end-of-life, OS packages, certificate
renewal and provider policy changes are all outside what this can reach. `doctor` remains the answer
there, and it still needs running.

### Settings

| variable | default | what it does |
| --- | --- | --- |
| `MAIL_UPDATE_MODE` | `check` | `off` pins the deployment; `check` reports; `apply` switches. A typo raises rather than guessing. |
| `MAIL_UPDATE_ROOT` | `update-store` | the version store |
| `MAIL_UPDATE_REPO` | this project | HTTPS only: TLS to the remote is the entire trust root |
| `MAIL_UPDATE_BRANCH` | `main` | whose tip is a release |
| `MAIL_UPDATE_UNIT` | `cutiemail.service` | the unit to stop and start |
| `MAIL_UPDATE_BAKE_DAYS` | `3` | how long a commit must sit before it is eligible |
| `MAIL_UPDATE_STALE_DAYS` | `30` | when `status` starts calling it a problem |
| `MAIL_UPDATE_KEEP` | `3` | superseded versions kept for rollback |
| `MAIL_UPDATE_DRAIN_SECONDS` | `120` | how long to wait for the daemon to finish before abandoning |
| `MAIL_UPDATE_PROBE_SECONDS` | `300` | how long the new version must stay healthy before it is confirmed |

## Upgrading by hand

Because the code *is* the runtime (no build, no compiled artefact), an upgrade is a `git pull`.
Schema migrations run **automatically and forward-only** the first time each database is opened.
Each database carries a schema epoch in `PRAGMA user_version`: migrations *within* an epoch are
additive (a new table or a defaulted column), so an older binary keeps reading a same-epoch
database. An upgrade that bumps the epoch stamps the store to the new number, and an **older
binary then refuses that database outright** with a clear error rather than opening it and
writing rows it would misread. So a downgrade after an epoch bump needs the pre-upgrade backup,
not just a code checkout. Always back up first, and stop the daemon before pulling so nothing is
mid-write:

```sh
# 1. back up and verify: this is your rollback (see below)
sudo -u mail node src/main.ts backup /backups/pre-upgrade-$(date +%F) --db /var/lib/mailserver/control.db
sudo -u mail node src/main.ts verify  /backups/pre-upgrade-$(date +%F)

# 2. stop, pull (as the checkout's owner: root here, since it was cloned with sudo), start
sudo systemctl stop mailserver
sudo git -C /opt/mailserver pull
sudo systemctl start mailserver

# 3. prove it: the outside, then the mail path
sudo -u mail env MAIL_DOMAIN=mail.example.com \
  MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem \
  MAIL_DKIM_KEY=/var/lib/mailserver/dkim/mail.key MAIL_DKIM_SELECTOR=s1 \
  node src/main.ts doctor
sudo -u mail env MAIL_DOMAIN=mail.example.com MAIL_SUBMISSION_PORT=587 MAIL_IMAP_PORT=993 \
  node src/main.ts selftest you
```

**To roll back**, checking out the old code is not enough if the upgrade bumped the schema
epoch: the previous version will **refuse** the migrated database (`database ... was written by a
newer cutiemail (schema vN); this binary understands up to vM`), a clean stop rather than a
silent misread. Restore the pre-upgrade backup you took in step 1 (`git -C /opt/mailserver
checkout <old-ref>`, stop the daemon, copy the snapshot back over the live databases as in
[Restoring from a backup](#day-2-operations-accounts-backups-the-queue), start again). That is
exactly why step 1 isn't optional. (An additive same-epoch upgrade would let the old binary open
the store, but restoring the matching backup is still the clean rollback.)

### One upgrade that can refuse to start: case-colliding logins

A login is **case-insensitive identity**: `ALICE` and `alice` are one account. The control
database now carries a unique index on `lower(login)` so that is a database constraint
rather than a convention every write path has to remember.

Almost every deployment is unaffected — `account add` and `init` have rejected
case-colliding logins for a long time. The exception is a registry seeded through
`MAIL_ACCOUNTS` before that guard existed, which could create both. On the first start
after upgrading, the daemon **refuses to boot** and names the pair:

```text
account registry has logins that differ only in case: ALICE, alice. A login is
case-insensitive identity — these share one mail-<login>.db on a case-insensitive
filesystem, so auth can read one row while a password change writes the other.
```

That is deliberate. The two accounts were already sharing one mailbox file on a
case-insensitive filesystem (macOS, some container volumes), and authentication could read
one row while a password change wrote the other — so a rotated password silently did
nothing. Refusing to start beats running like that.

To resolve it, with the daemon stopped:

1. `sudo -u mail node src/main.ts account list --db /var/lib/mailserver/control.db`, and
   check which spelling actually holds the mail (`mail-<login>.db`, beside the control DB).
2. Decide which one survives. There is deliberately no `account remove` (ADR 0012), so
   retiring the other means moving its messages into the survivor over IMAP (`imapsync`, or
   dragging the folders across in a mail client — see
   [Migrating your existing mail in](#migrating-your-existing-mail-in)), then deleting its
   row from `control.db` by hand.
3. Remove the colliding entry from `MAIL_ACCOUNTS` in the unit file, or it is seeded again
   on the next start.
4. Start the daemon and confirm with `selftest`.

If you would rather roll back and plan the migration properly, that is exactly what the
pre-upgrade backup from step 1 above is for.

## Decommissioning

Tearing it down cleanly is setup in reverse: stop the service, take the secrets and mail with
you (or destroy them deliberately), and pull the DNS so nothing points at a dead host:

```sh
# 1. stop and remove the service
sudo systemctl disable --now mailserver
sudo rm /etc/systemd/system/mailserver.service
sudo systemctl daemon-reload

# 2. take a final backup BEFORE you delete anything (skip only if you truly want the mail gone)
sudo -u mail node src/main.ts backup /backups/final-$(date +%F) --db /var/lib/mailserver/control.db

# 3. remove the data directory: this holds the DKIM PRIVATE KEY and every message in cleartext.
#    `rm -rf` is enough on most disks; on an SSD, disk-level secure erase is illusory, so if the
#    box is a VM, destroying the instance's disk is the real guarantee.
sudo rm -rf /var/lib/mailserver

# 4. the certificate and its renewal hook
sudo certbot delete --cert-name mail.example.com
sudo rm -f /etc/letsencrypt/renewal-hooks/deploy/mailserver-tls.sh
```

Finally, **remove the DNS records** you published (A, MX, PTR, and the SPF/DKIM/DMARC TXT records)
at your DNS host and VPS provider: a lingering MX pointing at a host that no longer answers just
delays mail for anyone who writes to the old address. Then delete the box.

## What actually happens on send and receive

Receiving: someone at Gmail emails `you@mail.example.com`:

```mermaid
sequenceDiagram
    participant G as Gmail
    participant D as daemon (port 25)
    participant DB as SQLite
    participant C as your client (IMAP)
    G->>D: looks up your MX, connects, delivers
    D->>DB: append message (byte-exact BLOB)
    C->>DB: SELECT INBOX, FETCH
    DB-->>C: the message, unchanged
```

Sending: you compose in Thunderbird to a Gmail address:

```mermaid
sequenceDiagram
    participant C as your client
    participant D as daemon (port 587)
    participant DNS as DNS
    participant M as Gmail's MX
    C->>D: STARTTLS, AUTH, MAIL/RCPT/DATA
    D-->>C: 250 accepted
    Note over D: recipient is remote → relay
    D->>DNS: MX of gmail.com?
    DNS-->>D: gmail-smtp-in.l.google.com ...
    D->>M: connect :25, deliver
    M-->>D: 250 (or a rejection you'll see in the log)
```

Both paths are the real code: the same `smtp-receiver`, `sqlite-mailbox`,
`imap-server`, and `outbound` relay that `daemon.integration.test.ts` and
`outbound.integration.test.ts` exercise end to end.

## Known limitations

These are deliberate and recorded:

- **Deliverability is more than DNS.** Getting SPF/DKIM/DMARC right gets you *past* a
  receiver's authentication checks; it does nothing for the other half of the decision, your
  IP and domain **reputation**, and this guide can't hand you that. Concretely: a brand-new
  cloud IP (exactly the throwaway-VPS path recommended above) is often *already* on a
  blocklist from whoever held it last, so check it against
  [Spamhaus](https://check.spamhaus.org/) and [mxtoolbox](https://mxtoolbox.com/blacklists.aspx)
  before trusting it. Microsoft (Outlook.com / Office 365) blocks large swathes of cloud IP
  ranges outright and expects you to enrol in [SNDS](https://sendersupport.olc.protection.outlook.com/snds/)
  and JMRP even with flawless auth. New domains and IPs are trusted slowly: reputation *warms
  up* over weeks of low, steady, wanted volume. And every "it reached the inbox" proof in this
  guide is Gmail: Gmail accepting your mail is a good sign, not universal acceptance.
- **DKIM signing is opt-in.** Without `MAIL_DKIM_KEY` (a PEM private key, RSA
  ≥1024-bit or Ed25519) and `MAIL_DKIM_SELECTOR` set, outbound delivery relies
  on SPF alone: accepted by the big providers, but reliably spam-foldered. The
  easy path is `node src/main.ts setup` (see [DNS](#dns)), which generates the
  key and prints the TXT record for `<selector>._domainkey.<domain>`; the
  openssl equivalent, if you prefer to see the moving parts:
  ```sh
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out dkim.key
  echo "v=DKIM1; k=rsa; p=$(openssl rsa -in dkim.key -pubout -outform DER 2>/dev/null | base64 -w0)"
  ```
  Signing is fail-open: a key problem sends the message unsigned rather than
  dropping it; deliverability degrades, mail is never lost.
- **`MAIL_DOMAIN` does double duty** as both the SMTP greeting/HELO name and the
  local mail domain. That's why this guide uses one name for host and domain
  (`you@mail.example.com`): a split like greeting `mail.example.com` + addresses
  `you@example.com` isn't separable yet.
- **Relay is IPv4-only, deliberately.** Gmail hard-rejects IPv6 connections
  without a matching v6 PTR and authentication; the PTR this guide sets is for
  the v4 address, so the relay pins `family: 4`. Revisit if you set up full
  IPv6 forward-confirmed rDNS.
- **Hardened at the protocol and OS layers, but not fully operationally.** The wire surface
  is hardened: SMTP-smuggling defence, DoS caps (recipient count, DATA
  scan, reply framing, a per-connection command-error limit on both SMTP and IMAP that drops
  a peer streaming junk), auth-header spoofing and DMARC display-spoof defences, an MX SSRF
  guard, bounded TLS handshakes, and bounded outbound reads and writes so one unresponsive or
  flooding MX cannot stall or exhaust the daemon. The auth paths carry a **per-IP brute-force throttle** (submission +
  IMAP; over the threshold, auth is refused without checking the password). The systemd unit
  is **sandboxed** (`systemd-analyze security` ≈ 1.6/OK: no-new-privileges, read-only
  filesystem bar the data dir, restricted syscalls/address-families/namespaces, private
  /tmp and /dev), and the data directory + every account database are owner-only. But there
  is still *no spam filtering and no fail2ban-style network banning*, and it has not been
  through a third-party security review. Don't put anything you care about behind it yet.
