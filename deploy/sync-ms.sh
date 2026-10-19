#!/usr/bin/env bash
# Sync-MS — Proxmox LXC + Docker (community-scripts / xdio wrapper)
# Spiegel van s4ndyp/scripts sync-ms/sync-ms.sh
# bash -c "$(curl -fsSL https://raw.githubusercontent.com/s4ndyp/scripts/main/sync-ms/sync-ms.sh)"

export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/s4ndyp/scripts/main}"

_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

if [[ -f "$(dirname "${BASH_SOURCE[0]}")/../lib/xdio.func" ]]; then
  # shellcheck source=/dev/null
  source "$(dirname "${BASH_SOURCE[0]}")/../lib/xdio.func"
else
  # shellcheck source=/dev/null
  source <(curl -fsSL "${COMMUNITY_SCRIPTS_URL}/lib/xdio.func")
fi

APP="Sync-MS"
var_tags="${var_tags:-syncthing;docker}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"
export var_docker_compose="${var_docker_compose:-yes}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -f /opt/sync-ms/docker-compose.yml ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi
  msg_info "Updating Sync-MS"
  cd /opt/sync-ms
  $STD docker compose pull
  $STD docker compose up -d
  msg_ok "Updated Sync-MS"
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Dashboard:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}${CL}"
echo -e "${INFO}${YW}Details: ~/sync-ms.creds${CL}"
