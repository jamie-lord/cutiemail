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

echo "waiting for cloud-init to finish (Node install, firewall)..."
until ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@$IP" 'cloud-init status --wait' 2>/dev/null | grep -q done; do
  sleep 5
done

echo "copying the mail server source..."
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '*.db' \
  "$REPO/" "root@$IP:/opt/mailserver/"
ssh "root@$IP" 'chown -R mail:mail /opt/mailserver'

echo "writing the service unit and starting it..."
ssh "root@$IP" "cat > /etc/systemd/system/mailserver.service" <<UNIT
[Unit]
Description=mail server (receive-first test)
After=network.target

[Service]
Type=simple
User=mail
WorkingDirectory=/opt/mailserver
ExecStart=/usr/bin/node src/main.ts
Environment=MAIL_DOMAIN=$MAIL_DOMAIN
Environment=MAIL_HOST=0.0.0.0
Environment=MAIL_DB=/var/lib/mailserver/mail.db
Environment=MAIL_SMTP_PORT=25
Environment=MAIL_SUBMISSION_PORT=587
Environment=MAIL_IMAP_PORT=993
Environment=MAIL_USER=$MAIL_USER
Environment=MAIL_PASS=$MAIL_PASS
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

ssh "root@$IP" 'systemctl daemon-reload && systemctl enable --now mailserver && sleep 1 && systemctl --no-pager status mailserver | head -6'

cat <<DONE

=== up. now set these DNS records at your registrar ===
  A    $MAIL_DOMAIN    $IP
  MX   $MAIL_DOMAIN    10 $MAIL_DOMAIN

Reverse DNS is already set. Once DNS propagates, email $MAIL_USER@$MAIL_DOMAIN
from your normal inbox and it should arrive.

  watch it land:   ssh root@$IP journalctl -fu mailserver
  read over IMAP:  IMAPS $MAIL_DOMAIN:993, user '$MAIL_USER' (self-signed cert -> accept the warning)
  destroy it all:  SERVER_NAME=$SERVER_NAME $DIR/hetzner-down.sh

Note: sending OUT to the world won't work yet — Hetzner blocks outbound port 25
on new accounts, and we haven't wired DKIM. This box is for receiving.
DONE
