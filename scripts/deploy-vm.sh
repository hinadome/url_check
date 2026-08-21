#!/usr/bin/env bash
# Deploy URL Checker on a Linux VM (Ubuntu/Debian-oriented).
# Usage:
#   ./scripts/deploy-vm.sh              # install deps, build, systemd + nginx front proxy
#   ./scripts/deploy-vm.sh --build-only # install + build, do not (re)start service
#   ./scripts/deploy-vm.sh --no-systemd # run `npm start` in foreground instead of systemd
#   ./scripts/deploy-vm.sh --no-nginx   # skip nginx; expose Next.js directly on PORT
#   PORT=3000 APP_USER=ubuntu ./scripts/deploy-vm.sh
#   APP_URL=https://checker.example.com NGINX_PORT=80 ./scripts/deploy-vm.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3000}"
APP_URL="${APP_URL:-}"
APP_NAME="${APP_NAME:-url-checker}"
APP_USER="${APP_USER:-$(id -un)}"
NODE_MAJOR="${NODE_MAJOR:-20}"
NGINX_PORT="${NGINX_PORT:-80}"
SERVER_NAME="${SERVER_NAME:-}"
CLIENT_MAX_BODY="${CLIENT_MAX_BODY:-50m}"
PROXY_READ_TIMEOUT="${PROXY_READ_TIMEOUT:-120s}"
BUILD_ONLY=0
NO_SYSTEMD=0
WITH_NGINX=1
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/url-checker.service"
NGINX_TEMPLATE="${ROOT_DIR}/deploy/nginx-url-checker.conf"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"

log() { printf '[deploy-vm] %s\n' "$*"; }
die() { printf '[deploy-vm] ERROR: %s\n' "$*" >&2; exit 1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

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

# Derive nginx server_name from SERVER_NAME, else host of APP_URL, else _.
resolve_server_name() {
  if [[ -n "$SERVER_NAME" ]]; then
    printf '%s' "$SERVER_NAME"
    return
  fi
  if [[ -n "$APP_URL" ]]; then
    # Prefer python3; fall back to sed for host extraction
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$APP_URL" <<'PY'
import sys
from urllib.parse import urlparse
print(urlparse(sys.argv[1]).hostname or "_")
PY
      return
    fi
    local host
    host="$(printf '%s' "$APP_URL" | sed -E 's#^https?://([^/:]+).*#\1#')"
    if [[ -n "$host" && "$host" != "$APP_URL" ]]; then
      printf '%s' "$host"
      return
    fi
  fi
  printf '_'
}

open_hint() {
  if [[ -n "$APP_URL" ]]; then
    printf '%s' "$APP_URL"
    return
  fi
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    if [[ "$NGINX_PORT" == "80" ]]; then
      printf 'http://<vm-host>/  (nginx → 127.0.0.1:%s)' "$PORT"
    else
      printf 'http://<vm-host>:%s/  (nginx → 127.0.0.1:%s)' "$NGINX_PORT" "$PORT"
    fi
    return
  fi
  printf 'http://<vm-host>:%s (or https:// via reverse proxy / TLS terminator)' "$PORT"
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
      run_root swapon "$swapfile" || true
    fi
    return
  fi

  run_root bash -c "fallocate -l '$swap_size' '$swapfile' || dd if=/dev/zero of='$swapfile' bs=1M count=2048"
  run_root chmod 600 "$swapfile"
  run_root mkswap "$swapfile"
  run_root swapon "$swapfile"
  log "Swap enabled"
}

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    --no-nginx) WITH_NGINX=0 ;;
    --with-nginx) WITH_NGINX=1 ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

# Foreground mode cannot usefully install a system nginx front; skip unless forced later.
if [[ "$NO_SYSTEMD" -eq 1 && "$WITH_NGINX" -eq 1 ]]; then
  log "Note: --no-systemd skips nginx install (use systemd deploy for nginx front)"
  WITH_NGINX=0
fi

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
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    pkgs+=(nginx)
  fi
  log "Installing base OS packages: ${pkgs[*]}"
  run_root apt-get update -y
  run_root apt-get install -y "${pkgs[@]}"
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

  local node_bin host
  node_bin="$(command -v node)"
  # Bind to localhost when nginx fronts the app; otherwise all interfaces.
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    host="127.0.0.1"
  else
    host="0.0.0.0"
  fi

  log "Installing systemd unit -> ${SERVICE_FILE} (listen ${host}:${PORT})"
  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__APP_DIR__|${ROOT_DIR}|g" \
    -e "s|__APP_USER__|${APP_USER}|g" \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__HOST__|${host}|g" \
    -e "s|__NODE_BIN__|${node_bin}|g" \
    "$UNIT_TEMPLATE" >"$tmp"

  run_root cp "$tmp" "$SERVICE_FILE"
  run_root chmod 644 "$SERVICE_FILE"
  run_root systemctl daemon-reload
  run_root systemctl enable "${APP_NAME}.service"
  run_root systemctl restart "${APP_NAME}.service"
  run_root systemctl --no-pager --full status "${APP_NAME}.service" || true
  rm -f "$tmp"
  log "Service ${APP_NAME}.service is enabled on ${host}:${PORT}"
}

configure_nginx() {
  [[ "$WITH_NGINX" -eq 1 ]] || return 0
  [[ -f "$NGINX_TEMPLATE" ]] || die "Missing nginx template: $NGINX_TEMPLATE"

  if ! command -v nginx >/dev/null 2>&1; then
    die "nginx not found after package install — install nginx or use --no-nginx"
  fi

  local server_name
  server_name="$(resolve_server_name)"
  log "Configuring nginx front proxy (listen :${NGINX_PORT}, server_name=${server_name} → 127.0.0.1:${PORT})"

  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__SERVER_NAME__|${server_name}|g" \
    -e "s|__NGINX_PORT__|${NGINX_PORT}|g" \
    -e "s|__APP_PORT__|${PORT}|g" \
    -e "s|__CLIENT_MAX_BODY__|${CLIENT_MAX_BODY}|g" \
    -e "s|__PROXY_READ_TIMEOUT__|${PROXY_READ_TIMEOUT}|g" \
    "$NGINX_TEMPLATE" >"$tmp"

  run_root cp "$tmp" "$NGINX_SITE_AVAILABLE"
  run_root chmod 644 "$NGINX_SITE_AVAILABLE"
  rm -f "$tmp"

  # Enable site; remove default site if it would steal port 80
  run_root ln -sfn "$NGINX_SITE_AVAILABLE" "$NGINX_SITE_ENABLED"
  if [[ -e /etc/nginx/sites-enabled/default ]]; then
    log "Disabling nginx default site (avoids conflict on port ${NGINX_PORT})"
    run_root rm -f /etc/nginx/sites-enabled/default
  fi

  run_root nginx -t
  run_root systemctl enable nginx
  run_root systemctl restart nginx
  run_root systemctl --no-pager --full status nginx || true
  log "nginx is fronting the app on port ${NGINX_PORT}"
  log "For HTTPS: ./scripts/setup-https.sh <domain> --email you@example.com"
}

start_foreground() {
  log "Starting app in foreground on port ${PORT} (Ctrl+C to stop)"
  export PORT
  export NODE_ENV=production
  npm start -- -H 0.0.0.0 -p "$PORT"
}

main() {
  validate_app_url
  log "Root: ${ROOT_DIR}"
  log "User: ${APP_USER}  Port: ${PORT}  nginx: $([[ "$WITH_NGINX" -eq 1 ]] && echo yes || echo no)"
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
    configure_nginx
    log "Done. Open $(open_hint)"
  else
    log "systemd not available — falling back to foreground start (nginx skipped)"
    WITH_NGINX=0
    start_foreground
  fi
}

main
