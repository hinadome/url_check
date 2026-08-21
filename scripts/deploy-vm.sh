#!/usr/bin/env bash
# Deploy URL Checker on a Linux VM (Ubuntu/Debian-oriented).
# Usage:
#   ./scripts/deploy-vm.sh              # install deps, build, start with systemd if available
#   ./scripts/deploy-vm.sh --build-only # install + build, do not (re)start service
#   ./scripts/deploy-vm.sh --no-systemd # run `npm start` in foreground instead of systemd
#   PORT=3000 APP_USER=ubuntu ./scripts/deploy-vm.sh
#   APP_URL=https://checker.example.com ./scripts/deploy-vm.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3000}"
APP_URL="${APP_URL:-}"
APP_NAME="${APP_NAME:-url-checker}"
APP_USER="${APP_USER:-$(id -un)}"
NODE_MAJOR="${NODE_MAJOR:-20}"
BUILD_ONLY=0
NO_SYSTEMD=0
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/url-checker.service"

log() { printf '[deploy-vm] %s\n' "$*"; }
die() { printf '[deploy-vm] ERROR: %s\n' "$*" >&2; exit 1; }

# Optional public URL printed after deploy (http:// or https://).
validate_app_url() {
  if [[ -z "$APP_URL" ]]; then
    return
  fi
  case "$APP_URL" in
    http://*|https://*) ;;
    *) die "APP_URL must start with http:// or https:// (got: ${APP_URL})" ;;
  esac
}

open_hint() {
  if [[ -n "$APP_URL" ]]; then
    printf '%s' "$APP_URL"
  else
    printf 'http://<vm-host>:%s (or https:// via reverse proxy / TLS terminator)' "$PORT"
  fi
}

# Optional: create a small swapfile when RAM is very low (helps npm/Playwright survive).
# Set ENSURE_SWAP=0 to disable. Default size 2G.
ensure_swap_if_needed() {
  if [[ "${ENSURE_SWAP:-1}" != "1" ]]; then
    return
  fi
  if ! command -v free >/dev/null 2>&1; then
    return
  fi

  local mem_mb swap_mb
  mem_mb="$(free -m | awk '/^Mem:/{print $2}')"
  swap_mb="$(free -m | awk '/^Swap:/{print $2}')"
  if [[ -z "$mem_mb" ]]; then
    return
  fi

  # Only auto-add swap on hosts with < 2048 MB RAM and little/no swap
  if [[ "$mem_mb" -ge 2048 ]]; then
    return
  fi
  if [[ "${swap_mb:-0}" -ge 1024 ]]; then
    log "Swap already present (${swap_mb} MB)"
    return
  fi

  local swapfile="${SWAPFILE_PATH:-/swapfile}"
  local swap_size="${SWAP_SIZE:-2G}"
  log "Low RAM (${mem_mb} MB) — ensuring swap ${swapfile} (${swap_size})"

  if [[ -f "$swapfile" ]]; then
    if ! swapon --show | grep -q "$swapfile"; then
      if [[ "$(id -u)" -eq 0 ]]; then
        swapon "$swapfile" || true
      else
        sudo swapon "$swapfile" || true
      fi
    fi
    return
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    fallocate -l "$swap_size" "$swapfile" || dd if=/dev/zero of="$swapfile" bs=1M count=2048
    chmod 600 "$swapfile"
    mkswap "$swapfile"
    swapon "$swapfile"
  else
    sudo fallocate -l "$swap_size" "$swapfile" || sudo dd if=/dev/zero of="$swapfile" bs=1M count=2048
    sudo chmod 600 "$swapfile"
    sudo mkswap "$swapfile"
    sudo swapon "$swapfile"
  fi
  log "Swap enabled"
}

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

  # Small VMs often OOM when `npm ci` runs postinstall `playwright install chromium`
  # at the same time as resolving packages. Split install + browser download.
  if command -v free >/dev/null 2>&1; then
    log "Memory before install:"
    free -h || true
  fi

  log "Installing npm dependencies (npm ci, skip Playwright browser download)"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  # --ignore-scripts avoids postinstall entirely (more reliable on low-RAM hosts)
  npm ci --ignore-scripts
  unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD

  log "Installing Playwright Chromium OS deps"
  if [[ "$(id -u)" -eq 0 ]]; then
    npx playwright install-deps chromium || true
  else
    sudo npx playwright install-deps chromium || true
  fi

  log "Downloading Playwright Chromium browser"
  npx playwright install chromium

  log "Building Next.js app"
  # Cap Node heap so the build is less likely to trigger the kernel OOM killer
  # on 1–2 GB VMs (override with NODE_OPTIONS if needed).
  if [[ -z "${NODE_OPTIONS:-}" ]]; then
    export NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE:-1536}"
  fi
  log "NODE_OPTIONS=${NODE_OPTIONS}"
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
  validate_app_url
  log "Root: ${ROOT_DIR}"
  log "User: ${APP_USER}  Port: ${PORT}"
  if [[ -n "$APP_URL" ]]; then
    log "APP_URL: ${APP_URL}"
  fi

  install_os_packages
  install_node_if_needed
  ensure_swap_if_needed
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
    log "Done. Open $(open_hint)"
  else
    log "systemd not available — falling back to foreground start"
    start_foreground
  fi
}

main
