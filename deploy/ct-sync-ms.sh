#!/usr/bin/env bash
# Spiegel van s4ndyp/scripts ct/sync-ms.sh — CT entrypoint naar sync-ms.sh
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/s4ndyp/scripts/main}"
# shellcheck source=/dev/null
source <(curl -fsSL "${COMMUNITY_SCRIPTS_URL}/sync-ms/sync-ms.sh")
