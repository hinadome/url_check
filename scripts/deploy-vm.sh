#!/usr/bin/env bash
# Deploy URL Checker on a Linux VM (Ubuntu/Debian-oriented).
# Usage:
#   ./scripts/deploy-vm.sh              # install deps, build, start with systemd if available
#   ./scripts/deploy-vm.sh --build-only # install + build, do not (re)start service
#   ./scripts/deploy-vm.sh --no-systemd # run `npm start` in foreground instead of systemd
#   PORT=3000 APP_USER=ubuntu ./scripts/deploy-vm.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3000}"
APP_NAME="${APP_NAME:-url-checker}"
APP_USER="${APP_USER:-$(id -un)}"
NODE_MAJOR="${NODE_MAJOR:-20}"
BUILD_ONLY=0
NO_SYSTEMD=0
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/url-checker.service"

log() { printf '[deploy-vm] %s\n' "$*"; }
die() { printf '[deploy-vm] ERROR: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

install_node_if_needed() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" -ge "$NODE_MAJOR" ]]; then
      log "Node $(node -v) OK"
      return
    fi
    log "Node $(node -v) is older than ${NODE_MAJOR}; installing Node ${NODE_MAJOR}.x"
  else
    log "Node not found; installing Node ${NODE_MAJOR}.x"
  fi

  need_cmd curl
  if [[ "$(id -u)" -eq 0 ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
}

install_os_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found — skipping OS package install (ensure Playwright system deps exist)"
    return
  fi

  local pkgs=(ca-certificates curl git build-essential)
  log "Installing base OS packages: ${pkgs[*]}"
  if [[ "$(id -u)" -eq 0 ]]; then
    apt-get update -y
    apt-get install -y "${pkgs[@]}"
  else
    sudo apt-get update -y
    sudo apt-get install -y "${pkgs[@]}"
  fi
}

install_app() {
  need_cmd npm
  log "Installing npm dependencies (npm ci)"
  npm ci

  log "Installing Playwright Chromium + OS deps"
  if [[ "$(id -u)" -eq 0 ]]; then
    npx playwright install-deps chromium || true
  else
    sudo npx playwright install-deps chromium || true
  fi
  npx playwright install chromium

  log "Building Next.js app"
  npm run build
}

write_systemd_unit() {
  [[ -f "$UNIT_TEMPLATE" ]] || die "Missing unit template: $UNIT_TEMPLATE"

  local node_bin npm_prefix
  node_bin="$(command -v node)"
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"

  log "Installing systemd unit -> ${SERVICE_FILE}"
  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__APP_DIR__|${ROOT_DIR}|g" \
    -e "s|__APP_USER__|${APP_USER}|g" \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__NODE_BIN__|${node_bin}|g" \
    "$UNIT_TEMPLATE" >"$tmp"

  if [[ "$(id -u)" -eq 0 ]]; then
    cp "$tmp" "$SERVICE_FILE"
    chmod 644 "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl enable "${APP_NAME}.service"
    systemctl restart "${APP_NAME}.service"
    systemctl --no-pager --full status "${APP_NAME}.service" || true
  else
    sudo cp "$tmp" "$SERVICE_FILE"
    sudo chmod 644 "$SERVICE_FILE"
    sudo systemctl daemon-reload
    sudo systemctl enable "${APP_NAME}.service"
    sudo systemctl restart "${APP_NAME}.service"
    sudo systemctl --no-pager --full status "${APP_NAME}.service" || true
  fi
  rm -f "$tmp"
  log "Service ${APP_NAME}.service is enabled on port ${PORT}"
  unset npm_prefix
}

start_foreground() {
  log "Starting app in foreground on port ${PORT} (Ctrl+C to stop)"
  export PORT
  export NODE_ENV=production
  npm start -- -p "$PORT"
}

main() {
  log "Root: ${ROOT_DIR}"
  log "User: ${APP_USER}  Port: ${PORT}"

  install_os_packages
  install_node_if_needed
  install_app

  if [[ "$BUILD_ONLY" -eq 1 ]]; then
    log "Build-only complete. Start later with: PORT=${PORT} npm start"
    exit 0
  fi

  if [[ "$NO_SYSTEMD" -eq 1 ]]; then
    start_foreground
    exit 0
  fi

  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    write_systemd_unit
    log "Done. Open http://<vm-host>:${PORT}"
  else
    log "systemd not available — falling back to foreground start"
    start_foreground
  fi
}

main
