#!/usr/bin/env bash
# Install syncms-disk-probe on a Syncthing host (one command).
# Usage: curl -fsSL https://raw.githubusercontent.com/s4ndyp/sync-ms/main/deploy/install-disk-probe.sh | sudo bash
set -euo pipefail

REPO="${SYNC_MS_REPO:-https://github.com/s4ndyp/sync-ms.git}"
REF="${SYNC_MS_REF:-main}"
BIN="/usr/local/bin/syncms-disk-probe"
SERVICE="/etc/systemd/system/syncms-disk-probe.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

if ! command -v git >/dev/null 2>&1; then
  echo "Install git first." >&2
  exit 1
fi
if ! command -v go >/dev/null 2>&1; then
  echo "Install Go (1.22+) to build syncms-disk-probe, or copy a prebuilt binary to $BIN" >&2
  exit 1
fi

git clone --depth 1 --branch "$REF" "$REPO" "$WORKDIR/src"
(
  cd "$WORKDIR/src"
  CGO_ENABLED=0 go build -ldflags="-s -w" -o "$BIN" ./cmd/syncms-disk-probe
)

cat >"$SERVICE" <<'UNIT'
[Unit]
Description=Sync-MS disk probe (df on demand, port 8765)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/syncms-disk-probe
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now syncms-disk-probe.service

echo "syncms-disk-probe active on port 8765 (no auth). Test: curl -s http://127.0.0.1:8765/health"
