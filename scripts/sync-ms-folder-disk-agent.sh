#!/usr/bin/env bash
# Sync-MS folder disk agent — run on each Syncthing host (not on the Sync-MS server).
# Reads local Syncthing folders (+ optional extra paths), reports free space to Sync-MS.
set -euo pipefail

CONFIG="${SYNC_MS_FOLDER_DISK_ENV:-/etc/sync-ms/folder-disk.env}"
if [[ -f "$CONFIG" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG"
fi

SYNC_MS_URL="${SYNC_MS_URL:-}"
SYNCTHING_URL="${SYNCTHING_URL:-http://127.0.0.1:8384}"
SYNCTHING_API_KEY="${SYNCTHING_API_KEY:-}"
SYNC_MS_INSTANCE_ID="${SYNC_MS_INSTANCE_ID:-}"
EXTRA_PATHS_FILE="${EXTRA_PATHS_FILE:-/etc/sync-ms/folder-disk-extra.paths}"

log() { printf 'sync-ms-folder-disk-agent: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "vereist commando: $1 (installeer het pakket op deze host)"
}

need_cmd curl
need_cmd jq
need_cmd df

[[ -n "$SYNC_MS_URL" ]] || die "SYNC_MS_URL ontbreekt (bijv. https://sync-ms.example:8096)"
[[ -n "$SYNCTHING_API_KEY" ]] || die "SYNCTHING_API_KEY ontbreekt (Syncthing GUI → Instellingen → API)"

SYNC_MS_URL="${SYNC_MS_URL%/}"

st_get() {
  local path=$1
  curl -fsS -H "X-API-Key: ${SYNCTHING_API_KEY}" "${SYNCTHING_URL}${path}"
}

expand_path() {
  local p=$1 home=$2
  case "$p" in
    "~") printf '%s' "$home" ;;
    "~/"*) printf '%s' "${home}/${p#~/}" ;;
    *) printf '%s' "$p" ;;
  esac
}

# GNU df: total bytes, available bytes (non-root)
disk_bytes_for_path() {
  local target=$1
  if [[ ! -e "$target" ]]; then
    return 1
  fi
  if [[ -f "$target" ]]; then
    target=$(dirname "$target")
  fi
  df -P -B1 -- "$target" 2>/dev/null | awk 'NR==2 { print $2, $4 }'
}

add_folder_json() {
  local id=$1 label=$2 path=$3 home=$4
  [[ -n "$id" && -n "$path" ]] || return 0
  local resolved shell_path
  resolved=$(expand_path "$path" "$home")
  read -r total free _ < <(disk_bytes_for_path "$resolved") || {
    log "overslaan $id ($resolved): pad niet leesbaar of df mislukt"
    return 0
  }
  [[ -n "$label" ]] || label=$id
  FOLDER_JSON=$(jq -c \
    --arg id "$id" \
    --arg label "$label" \
    --argjson free "$free" \
    --argjson total "$total" \
    '. + [{folder_id: $id, folder_label: $label, free_bytes: $free, total_bytes: $total}]' \
    <<<"${FOLDER_JSON:-[]}")
}

FOLDER_JSON="[]"

STATUS_JSON=$(st_get "/rest/system/status") || die "Syncthing status niet bereikbaar op ${SYNCTHING_URL}"
HOME_DIR=$(jq -r '.tilde // ""' <<<"$STATUS_JSON")
DEVICE_ID=$(jq -r '.myID // ""' <<<"$STATUS_JSON")
[[ -n "$DEVICE_ID" ]] || die "Syncthing myID ontbreekt in status"

FOLDERS_JSON=$(st_get "/rest/config/folders") || die "Syncthing config/folders mislukt"
while IFS= read -r row; do
  id=$(jq -r '.id // ""' <<<"$row")
  label=$(jq -r '.label // ""' <<<"$row")
  path=$(jq -r '.path // ""' <<<"$row")
  add_folder_json "$id" "$label" "$path" "$HOME_DIR"
done < <(jq -c '.[]' <<<"$FOLDERS_JSON")

if [[ -f "$EXTRA_PATHS_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line=$(echo "$line" | tr -d '\r')
    [[ -z "${line// /}" ]] && continue
    IFS='|' read -r eid elabel epath <<<"$line"
    eid=$(echo "$eid" | xargs)
    elabel=$(echo "${elabel:-}" | xargs)
    epath=$(echo "$epath" | xargs)
    add_folder_json "$eid" "$elabel" "$epath" "$HOME_DIR"
  done <"$EXTRA_PATHS_FILE"
fi

COUNT=$(jq 'length' <<<"$FOLDER_JSON")
if [[ "$COUNT" -eq 0 ]]; then
  die "geen mappen met schijfmeting (controleer Syncthing-mappen en paden)"
fi

PAYLOAD=$(jq -n \
  --arg device_id "$DEVICE_ID" \
  --arg instance_id "$SYNC_MS_INSTANCE_ID" \
  --argjson folders "$FOLDER_JSON" \
  '{
    device_id: $device_id,
    folders: $folders
  } + (if ($instance_id | length) > 0 then {instance_id: $instance_id} else {} end)')

RESP_FILE=$(mktemp)
trap 'rm -f "$RESP_FILE"' EXIT

HTTP=$(curl -sS -w '%{http_code}' -o "$RESP_FILE" \
  -X POST "${SYNC_MS_URL}/api/syncms/folder-disk-report" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD") || die "POST naar Sync-MS mislukt"

if [[ "$HTTP" != "200" ]]; then
  msg=$(jq -r '.error // .message // empty' <"$RESP_FILE" 2>/dev/null || true)
  die "Sync-MS antwoord HTTP ${HTTP}${msg:+ — $msg}"
fi

created=$(jq -r '.created // 0' <"$RESP_FILE")
name=$(jq -r '.instanceName // ""' <"$RESP_FILE")
log "ok: ${created} metingen voor ${name:-instance} (${COUNT} mappen)"
