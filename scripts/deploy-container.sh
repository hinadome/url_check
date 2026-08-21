#!/usr/bin/env bash
# Build and run URL Checker in Docker (Compose).
# Usage:
#   ./scripts/deploy-container.sh           # build + up -d
#   ./scripts/deploy-container.sh --build   # force rebuild + up -d
#   ./scripts/deploy-container.sh --down    # stop and remove containers
#   ./scripts/deploy-container.sh --logs    # follow logs
#   PORT=3000 ./scripts/deploy-container.sh
#   APP_URL=https://checker.example.com ./scripts/deploy-container.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3000}"
APP_URL="${APP_URL:-}"
COMPOSE=(docker compose)
ACTION="up"

log() { printf '[deploy-container] %s\n' "$*"; }
die() { printf '[deploy-container] ERROR: %s\n' "$*" >&2; exit 1; }

# Optional public URL shown after a healthy start (http:// or https://).
validate_app_url() {
  if [[ -z "$APP_URL" ]]; then
    return
  fi
  case "$APP_URL" in
    http://*|https://*) ;;
    *) die "APP_URL must start with http:// or https:// (got: ${APP_URL})" ;;
  esac
}

# Probe local app over HTTP, then HTTPS (self-signed OK via -k).
probe_local() {
  curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 \
    || curl -fsSk "https://127.0.0.1:${PORT}/" >/dev/null 2>&1
}

# When APP_URL is set, also accept that origin (http or https).
probe_app_url() {
  [[ -n "$APP_URL" ]] || return 1
  case "$APP_URL" in
    https://*) curl -fsSk "${APP_URL%/}/" >/dev/null 2>&1 ;;
    http://*) curl -fsS "${APP_URL%/}/" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

open_hint() {
  if [[ -n "$APP_URL" ]]; then
    printf '%s' "$APP_URL"
  else
    printf 'http://127.0.0.1:%s (or https:// if TLS terminates on this port)' "$PORT"
  fi
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  if ! docker compose version >/dev/null 2>&1; then
    if command -v docker-compose >/dev/null 2>&1; then
      COMPOSE=(docker-compose)
    else
      die "Docker Compose not found (need \`docker compose\` or docker-compose)"
    fi
  fi
}

for arg in "$@"; do
  case "$arg" in
    --build) ACTION="rebuild" ;;
    --down) ACTION="down" ;;
    --logs) ACTION="logs" ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

main() {
  need_docker
  validate_app_url
  export PORT

  log "Root: ${ROOT_DIR}"
  log "Host port: ${PORT} -> container 3000"
  if [[ -n "$APP_URL" ]]; then
    log "APP_URL: ${APP_URL}"
  fi

  case "$ACTION" in
    up)
      log "Building (if needed) and starting"
      "${COMPOSE[@]}" up -d --build
      ;;
    rebuild)
      log "Force rebuild and start"
      "${COMPOSE[@]}" build --no-cache
      "${COMPOSE[@]}" up -d --force-recreate
      ;;
    down)
      log "Stopping stack"
      "${COMPOSE[@]}" down
      log "Stopped"
      exit 0
      ;;
    logs)
      "${COMPOSE[@]}" logs -f url-checker
      exit 0
      ;;
  esac

  log "Waiting for health (http or https)..."
  local i
  for i in $(seq 1 60); do
    if probe_local || probe_app_url; then
      log "Healthy — open $(open_hint)"
      "${COMPOSE[@]}" ps
      exit 0
    fi
    sleep 2
  done

  log "Container may still be starting. Check: ${COMPOSE[*]} logs -f url-checker"
  "${COMPOSE[@]}" ps || true
}

main
