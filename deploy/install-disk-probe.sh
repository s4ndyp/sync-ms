#!/usr/bin/env bash
# Install syncms-disk-probe on a Syncthing host (one command).
# Usage: curl -fsSL https://raw.githubusercontent.com/s4ndyp/sync-ms/main/deploy/install-disk-probe.sh | sudo bash
set -euo pipefail

GITHUB_REPO="${SYNC_MS_GITHUB_REPO:-s4ndyp/sync-ms}"
PROBE_TAG="${SYNC_MS_PROBE_TAG:-disk-probe-latest}"
BIN="/usr/local/bin/syncms-disk-probe"
SERVICE="/etc/systemd/system/syncms-disk-probe.service"

log() { printf 'install-disk-probe: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "run as root (sudo)"
fi

case "$(uname -m)" in
  x86_64 | amd64) GOARCH=amd64 ;;
  aarch64 | arm64) GOARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m) (need amd64 or arm64)" ;;
esac

ASSET="syncms-disk-probe-linux-${GOARCH}"
BASE="https://github.com/${GITHUB_REPO}/releases/download/${PROBE_TAG}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

log "downloading ${BASE}/${ASSET}"
if ! curl -fsSL "${BASE}/${ASSET}" -o "$TMP"; then
  die "download failed — is release ${PROBE_TAG} published? (merge to main first)"
fi

install -m 0755 "$TMP" "$BIN"

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

log "syncms-disk-probe active on port 8765 (no auth)"
log "test: curl -s http://127.0.0.1:8765/health"
