#!/usr/bin/env bash
# Installeer de Sync-MS schijfruimte-agent op deze Syncthing-host.
# Gebruik: sudo bash deploy/install-folder-disk-agent.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_SRC="${ROOT}/scripts/sync-ms-folder-disk-agent.sh"
ENV_DEST="/etc/sync-ms/folder-disk.env"
ENV_EXAMPLE="${ROOT}/deploy/folder-disk-agent.env.example"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Draai als root (sudo)." >&2
  exit 1
fi

for cmd in curl jq df; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Installeer eerst: $cmd" >&2
    exit 1
  fi
done

install -d /etc/sync-ms
install -m 0755 "$AGENT_SRC" /usr/local/bin/sync-ms-folder-disk-agent

if [[ ! -f "$ENV_DEST" ]]; then
  install -m 0600 "$ENV_EXAMPLE" "$ENV_DEST"
  echo "Aangemaakt: $ENV_DEST — vul SYNC_MS_URL en SYNCTHING_API_KEY in."
else
  echo "Behouden: $ENV_DEST"
fi

if [[ ! -f /etc/sync-ms/folder-disk-extra.paths ]]; then
  install -m 0644 "${ROOT}/deploy/folder-disk-extra.paths.example" /etc/sync-ms/folder-disk-extra.paths
fi

install -m 0644 "${ROOT}/deploy/folder-disk-agent.service" /etc/systemd/system/sync-ms-folder-disk-agent.service
install -m 0644 "${ROOT}/deploy/folder-disk-agent.timer" /etc/systemd/system/sync-ms-folder-disk-agent.timer

systemctl daemon-reload
systemctl enable --now sync-ms-folder-disk-agent.timer

echo "Timer actief: sync-ms-folder-disk-agent.timer (elke minuut)."
echo "Test handmatig: sudo sync-ms-folder-disk-agent"
