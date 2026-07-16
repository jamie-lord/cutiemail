#!/usr/bin/env bash
#
# Destroy the throwaway mail server created by hetzner-up.sh. Billing stops the
# moment the server is deleted (Hetzner bills by the hour).
#
# Usage:  ./deploy/hetzner-down.sh          (deletes 'mailserver-test')
#         SERVER_NAME=other ./deploy/hetzner-down.sh
#
set -euo pipefail

SERVER_NAME="${SERVER_NAME:-mailserver-test}"

command -v hcloud >/dev/null || { echo "install the hcloud CLI: https://github.com/hetznercloud/cli"; exit 1; }

if ! hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
  echo "no server named '$SERVER_NAME' — nothing to delete."
  exit 0
fi

echo "deleting $SERVER_NAME..."
hcloud server delete "$SERVER_NAME"
echo "done — billing has stopped."
