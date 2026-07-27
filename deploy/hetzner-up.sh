#!/usr/bin/env bash
#
# Spin up a throwaway Hetzner box running the mail server, configured to RECEIVE.
# Creates the server, waits for cloud-init, copies the source, sets reverse DNS,
# writes the systemd unit with your config, and starts it. Prints the DNS records
# to set. Tear it all down with hetzner-down.sh.
#
# Prerequisites (once):
#   - hcloud CLI installed:            https://github.com/hetznercloud/cli
#   - authenticated:                   export HCLOUD_TOKEN=...   (or: hcloud context create mail)
#   - an SSH key uploaded to Hetzner:  hcloud ssh-key list       (pass its name as SSH_KEY_NAME)
#
# Usage:
#   MAIL_DOMAIN=mail.example.com MAIL_PASS='a-real-passphrase' SSH_KEY_NAME=mykey ./deploy/hetzner-up.sh
#
set -euo pipefail

SERVER_NAME="${SERVER_NAME:-mailserver-test}"
SERVER_TYPE="${SERVER_TYPE:-cax11}"     # ARM, ~EUR 3.8/mo == ~EUR 0.006/hr, the cheapest
IMAGE="${IMAGE:-ubuntu-24.04}"
LOCATION="${LOCATION:-nbg1}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
MAIL_DOMAIN="${MAIL_DOMAIN:?set MAIL_DOMAIN, e.g. mail.example.com (used as hostname AND mail domain)}"
MAIL_USER="${MAIL_USER:-you}"
MAIL_PASS="${MAIL_PASS:?set MAIL_PASS to the passphrase for your account}"

command -v hcloud >/dev/null || { echo "install the hcloud CLI: https://github.com/hetznercloud/cli"; exit 1; }
[ -n "$SSH_KEY_NAME" ] || { echo "set SSH_KEY_NAME to a key from 'hcloud ssh-key list'"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

echo "creating $SERVER_NAME ($SERVER_TYPE, $IMAGE, $LOCATION)..."
hcloud server create \
  --name "$SERVER_NAME" \
  --type "$SERVER_TYPE" \
  --image "$IMAGE" \
  --location "$LOCATION" \
  --ssh-key "$SSH_KEY_NAME" \
  --user-data-from-file "$DIR/cloud-init.yaml"

IP="$(hcloud server ip "$SERVER_NAME")"
echo "server IP: $IP"

# Reverse DNS so the connecting IP resolves back to the mail name (senders check this).
echo "setting reverse DNS ($IP -> $MAIL_DOMAIN)..."
hcloud server set-rdns "$SERVER_NAME" --ip "$IP" --hostname "$MAIL_DOMAIN"

# Wait for cloud-init, on its OUTPUT rather than its exit status, and with a deadline.
#
# `cloud-init status --wait` exits 2 when it finishes with recoverable errors — "degraded done",
# which is a completed boot, not a failed one. The previous form piped it to `grep -q done` under
# `set -o pipefail`, so the pipeline took ssh's exit code and the grep's success was discarded:
# the loop could never terminate. Its stderr went to /dev/null, so it span silently and forever,
# leaving a running, paid-for, empty server behind. Both halves mattered — a schema slip in
# cloud-init.yaml was enough to trigger it, and nothing said so.
#
# The text is what actually answers the question being asked, so the text is what is tested. The
# deadline is here because "wait for a remote machine" with no bound is how a script hangs rather
# than fails, and a failure an operator can see beats a hang they have to diagnose.
echo "waiting for cloud-init to finish (Node install, firewall)..."
CLOUD_INIT_DEADLINE=$(( SECONDS + 900 ))
while :; do
  CI_OUT="$(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@$IP" 'cloud-init status --wait' 2>&1 || true)"
  case "$CI_OUT" in
    *done*) break ;;
  esac
  if [ "$SECONDS" -ge "$CLOUD_INIT_DEADLINE" ]; then
    echo "cloud-init did not report done within 15 minutes. Last output:" >&2
    echo "$CI_OUT" >&2
    exit 1
  fi
  sleep 5
done
case "$CI_OUT" in
  *degraded*)
    echo "note: cloud-init finished DEGRADED — it completed, but something in the cloud-config was"
    echo "      rejected. Check with: ssh root@$IP cloud-init schema --system"
    ;;
esac

# The version-store layout (ADR 0025): the code lives at versions/<commit>, and `current` is a
# symlink naming which one runs. That is what makes an update a rename and a rollback the same
# rename in reverse. A deployment installed as a flat directory can never be updated automatically,
# so it is laid out this way from the first minute.
#
# Only a CLEAN checkout gets wired up for updates. Recording a commit while shipping a modified
# working tree would make the store's ancestry a lie: every later update would be compared against a
# commit whose content was never what is running.
COMMIT="$(cd "$REPO" && git rev-parse HEAD 2>/dev/null || true)"
if [ -n "$(cd "$REPO" && git status --porcelain 2>/dev/null || echo dirty)" ]; then
  echo "note: this working tree has uncommitted changes, so automatic updates will NOT be configured."
  COMMIT=""
fi
VERSION_DIR="/opt/mailserver/versions/${COMMIT:-working-tree}"

echo "copying the mail server source to $VERSION_DIR..."
ssh "root@$IP" "mkdir -p $VERSION_DIR"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '*.db' \
  "$REPO/" "root@$IP:$VERSION_DIR/"

# The daemon must NEVER be able to write its own code. It is the internet-facing part, and if a
# remote compromise of it could rewrite what runs next, that compromise becomes permanent. So the
# code is owned by a separate updater user and the mail user only ever reads it. (This corrects an
# earlier `chown -R mail:mail /opt/mailserver`, which handed the daemon exactly that ability.)
ssh "root@$IP" "id -u mailupd >/dev/null 2>&1 || useradd --system --home-dir /opt/mailserver --shell /usr/sbin/nologin mailupd"
ssh "root@$IP" "ln -sfn versions/${COMMIT:-working-tree} /opt/mailserver/current.tmp && mv -T /opt/mailserver/current.tmp /opt/mailserver/current"
ssh "root@$IP" "chown -R mailupd:mailupd /opt/mailserver && chmod -R u=rwX,go=rX /opt/mailserver"

# Provision a per-box TLS certificate. The daemon REFUSES to serve the bundled dev cert on
# a public interface (its private key is committed), so we generate a fresh key/cert here.
# This is self-signed (clients accept the warning); upgrade to Let's Encrypt once DNS points
# at the box: `certbot certonly --standalone -d $MAIL_DOMAIN` and repoint MAIL_TLS_CERT/KEY.
echo "generating a per-box TLS certificate (self-signed; upgrade to Let's Encrypt — see note)..."
ssh "root@$IP" "mkdir -p /var/lib/mailserver/tls && \
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout /var/lib/mailserver/tls/key.pem -out /var/lib/mailserver/tls/cert.pem \
    -subj '/CN=$MAIL_DOMAIN' -addext 'subjectAltName=DNS:$MAIL_DOMAIN' >/dev/null 2>&1 && \
  chown -R mail:mail /var/lib/mailserver && chmod 600 /var/lib/mailserver/tls/key.pem && \
  chmod 700 /var/lib/mailserver /var/lib/mailserver/tls"

echo "writing the service unit and starting it..."
ssh "root@$IP" "cat > /etc/systemd/system/mailserver.service" <<UNIT
[Unit]
Description=mail server (receive-first test)
After=network.target

[Service]
Type=simple
User=mail
# Through `current`, so a version cutover is a symlink rename plus a restart (ADR 0025).
WorkingDirectory=/opt/mailserver/current
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/mailserver/current/src/main.ts
Environment=MAIL_DOMAIN=$MAIL_DOMAIN
Environment=MAIL_HOST=0.0.0.0
Environment=MAIL_CONTROL_DB=/var/lib/mailserver/control.db
Environment=MAIL_DB=/var/lib/mailserver/mail.db
Environment=MAIL_SMTP_PORT=25
Environment=MAIL_SUBMISSION_PORT=587
Environment=MAIL_IMAP_PORT=993
Environment=MAIL_USER=$MAIL_USER
Environment=MAIL_PASS=$MAIL_PASS
Environment=MAIL_TLS_CERT=/var/lib/mailserver/tls/cert.pem
Environment=MAIL_TLS_KEY=/var/lib/mailserver/tls/key.pem
# Bind privileged ports (25/587/993) without root, and nothing more.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# Defense-in-depth sandboxing for a single-process internet-facing daemon
# (systemd-analyze security: 9.3 UNSAFE -> 1.6 OK). MemoryDenyWriteExecute is
# deliberately OMITTED: the V8 JIT needs W+X memory and Node will not start with it.
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
# AF_INET/AF_INET6 for SMTP/IMAP + c-ares DNS; AF_UNIX for local sockets.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
UMask=0077
# File-descriptor ceiling. Each open user mail DB holds ~3 fds (db + -wal + -shm) plus
# one per live IMAP connection; the default 1024 would be a hard wall well before memory
# (docs/PERFORMANCE.md). One store is cached per real account, so this is generous
# headroom, not a workaround for a leak.
LimitNOFILE=65536
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

# The unit carries MAIL_PASS (the throwaway-box trade-off documented in docs/DEPLOYMENT.md;
# the manual path uses `init` instead and its unit holds no password). A root `cat >` creates it
# 0644 under the default umask, so tighten it — though note `systemctl show mailserver` still
# prints Environment= to any local user, and the passphrase is in the invoking shell's history.
ssh "root@$IP" 'chmod 600 /etc/systemd/system/mailserver.service'
ssh "root@$IP" 'systemctl daemon-reload && systemctl enable --now mailserver && sleep 1 && systemctl --no-pager status mailserver | head -6'

# ---- automatic updates (ADR 0025, docs/SELF-UPDATE.md) ---------------------------------------
# Skipped for a dirty working tree: see the note where COMMIT is computed.
if [ -n "$COMMIT" ]; then
  echo "wiring up automatic updates (reporting only; set MAIL_UPDATE_MODE=apply to let it switch)..."

  # The updater needs to read and snapshot the databases, and to restart the one unit it manages.
  # It gets group access to the data directory rather than ownership: the mail user still owns its
  # own mail.
  # The updater must read every database to snapshot them, and write the control database, because
  # the cutover probe mints and revokes a credential there. It runs as its own user by design — a
  # compromise of the thing that downloads code must not be a compromise of the mail — so that
  # access has to be granted explicitly.
  #
  # Plain group ownership, and nothing cleverer. An ACL cannot work here: the daemon chmods its
  # databases on EVERY open (secureMailDbFile), and a chmod resets an ACL's mask to nothing, so the
  # grant survives exactly until the next restart — which a cutover always performs. That failure is
  # silent and delayed: the pre-flight passes once, then fails forever blaming the data. The daemon
  # now sets 0660 rather than 0600, which means the GROUP is the access-control decision and the
  # daemon's own enforcement cooperates with it instead of fighting it. World still gets nothing.
  #
  # The directory is group-writable because the revert path restores databases from the pre-cutover
  # snapshot, which means creating files here — and that path runs precisely when something has
  # already gone wrong, which is the worst moment to discover a permission error.
  ssh "root@$IP" 'usermod -a -G mail mailupd'
  ssh "root@$IP" 'chown -R mail:mail /var/lib/mailserver && chmod 770 /var/lib/mailserver && chmod 660 /var/lib/mailserver/*.db* 2>/dev/null; true'

  # Exactly one unit, exactly one verb each way. Without this the updater would have to run as root,
  # and a compromise of the thing that downloads code would be a compromise of everything.
  ssh "root@$IP" "cat > /etc/polkit-1/rules.d/50-mailserver-update.rules" <<'POLKIT'
polkit.addRule(function (action, subject) {
  if (action.id === 'org.freedesktop.systemd1.manage-units'
      && subject.user === 'mailupd'
      && action.lookup('unit') === 'mailserver.service'
      && ['start', 'stop', 'restart'].indexOf(action.lookup('verb')) !== -1) {
    return polkit.Result.YES;
  }
});
POLKIT

  ssh "root@$IP" "cat > /etc/systemd/system/mailserver-update.service" <<UPDATE
[Unit]
Description=cutiemail update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=mailupd
WorkingDirectory=/opt/mailserver/current
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/mailserver/current/src/update/main.ts auto
Environment=MAIL_UPDATE_ROOT=/opt/mailserver
Environment=MAIL_UPDATE_UNIT=mailserver.service
# Reporting only until the mechanism has earned trust on this deployment; then set 'apply'.
Environment=MAIL_UPDATE_MODE=check
# The daemon's own configuration, because the pre-flight boots a candidate against a SNAPSHOT of
# your data with your real settings. MAIL_OUTBOUND is forced to hold there regardless of this.
Environment=MAIL_DOMAIN=$MAIL_DOMAIN
Environment=MAIL_CONTROL_DB=/var/lib/mailserver/control.db
Environment=MAIL_SMTP_PORT=25
Environment=MAIL_SUBMISSION_PORT=587
Environment=MAIL_IMAP_PORT=993
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/mailserver /var/lib/mailserver
PrivateTmp=true
UMask=0077
# The pre-flight imports the candidate's module graph and boots it several times, twice against a
# snapshot of the real data. The migration is the part that scales with your mailbox, so give it
# room — and note the pre-flight now reads THIS value and reports the migration it measured as a
# share of it, so a budget that is getting tight says so before it bites.
TimeoutStartSec=45min
UPDATE

  ssh "root@$IP" "cat > /etc/systemd/system/mailserver-update.timer" <<'TIMER'
[Unit]
Description=cutiemail update check

[Timer]
# Six-hourly, with a wide random delay so every deployment does not hit the remote at once.
OnCalendar=*-*-* 0/6:00:00
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
TIMER

  ssh "root@$IP" "systemctl daemon-reload && systemctl restart polkit && systemctl enable --now mailserver-update.timer"
  # Adoption FETCHES the tree from the remote rather than trusting what was just rsynced, so the
  # store holds only content-verified checkouts and a wrong commit fails here rather than silently
  # poisoning every later comparison.
  ssh "root@$IP" "sudo -u mailupd MAIL_UPDATE_ROOT=/opt/mailserver /usr/bin/node --disable-warning=ExperimentalWarning /opt/mailserver/current/src/update/main.ts adopt $COMMIT"
  UPDATE_NOTE="  update status:   ssh root@$IP 'sudo -u mailupd MAIL_UPDATE_ROOT=/opt/mailserver node /opt/mailserver/current/src/update/main.ts status'
                   (checks run six-hourly and only REPORT; docs/SELF-UPDATE.md to let it switch)"
else
  UPDATE_NOTE="  updates:         not wired up (the working tree was dirty); see docs/SELF-UPDATE.md"
fi

cat <<DONE

=== up. now set these DNS records at your registrar ===
  A    $MAIL_DOMAIN    $IP
  MX   $MAIL_DOMAIN    10 $MAIL_DOMAIN

Reverse DNS is already set. Once DNS propagates, email $MAIL_USER@$MAIL_DOMAIN
from your normal inbox and it should arrive.

  watch it land:   ssh root@$IP journalctl -fu mailserver
$UPDATE_NOTE
  read over IMAP:  IMAPS $MAIL_DOMAIN:993, user '$MAIL_USER' (per-box self-signed cert -> accept
                   the warning, or upgrade to Let's Encrypt: certbot certonly --standalone
                   -d $MAIL_DOMAIN, then repoint MAIL_TLS_CERT/MAIL_TLS_KEY at the live cert)
  destroy it all:  SERVER_NAME=$SERVER_NAME $DIR/hetzner-down.sh

Note: outbound relay needs port 25 open OUTBOUND (blocked on new Hetzner
accounts — test: nc gmail-smtp-in.l.google.com 25) and an SPF record:
  TXT  $MAIL_DOMAIN  "v=spf1 ip4:$IP -all"
Without DKIM expect first sends to land in spam.
DONE
