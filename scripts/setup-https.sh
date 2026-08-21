#!/usr/bin/env bash
# Obtain a Let's Encrypt certificate and configure nginx for HTTPS
# after URL Checker has been deployed on a VM (deploy-vm.sh).
#
# Usage:
#   ./scripts/setup-https.sh checker.example.com
#   ./scripts/setup-https.sh checker.example.com --email ops@example.com
#   CERTBOT_EMAIL=ops@example.com ./scripts/setup-https.sh checker.example.com
#   ./scripts/setup-https.sh checker.example.com --staging   # Let's Encrypt staging
#   ./scripts/setup-https.sh checker.example.com --force-renew
#
# Prerequisites:
#   - DNS A/AAAA for DOMAIN → this VM's public IP
#   - Ports 80 and 443 reachable from the internet
#   - App already deployed with nginx (./scripts/deploy-vm.sh)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="${APP_NAME:-url-checker}"
PORT="${PORT:-3000}"
CLIENT_MAX_BODY="${CLIENT_MAX_BODY:-50m}"
PROXY_READ_TIMEOUT="${PROXY_READ_TIMEOUT:-120s}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
STAGING=0
FORCE_RENEW=0
DOMAIN=""

NGINX_HTTP_TEMPLATE="${ROOT_DIR}/deploy/nginx-url-checker.conf"
NGINX_HTTPS_TEMPLATE="${ROOT_DIR}/deploy/nginx-url-checker-https.conf"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"
WEBROOT="/var/www/certbot"

log() { printf '[setup-https] %s\n' "$*"; }
die() { printf '[setup-https] ERROR: %s\n' "$*" >&2; exit 1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

usage() {
  sed -n '2,16p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --email)
      shift
      [[ $# -gt 0 ]] || die "--email requires an address"
      CERTBOT_EMAIL="$1"
      ;;
    --email=*)
      CERTBOT_EMAIL="${1#--email=}"
      ;;
    --staging)
      STAGING=1
      ;;
    --force-renew)
      FORCE_RENEW=1
      ;;
    -*)
      die "Unknown option: $1 (see --help)"
      ;;
    *)
      if [[ -n "$DOMAIN" ]]; then
        die "Only one domain is supported (got extra: $1)"
      fi
      DOMAIN="$1"
      ;;
  esac
  shift
done

[[ -n "$DOMAIN" ]] || die "Domain is required. Example: ./scripts/setup-https.sh checker.example.com"

# Basic domain sanity (hostname labels)
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  die "Invalid domain name: ${DOMAIN}"
fi
if [[ "$DOMAIN" == *"*"* ]]; then
  die "Wildcard domains are not supported by this script"
fi

[[ -f "$NGINX_HTTPS_TEMPLATE" ]] || die "Missing template: $NGINX_HTTPS_TEMPLATE"
[[ -f "$NGINX_HTTP_TEMPLATE" ]] || die "Missing template: $NGINX_HTTP_TEMPLATE"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

install_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    die "apt-get not found — this script targets Ubuntu/Debian"
  fi

  local pkgs=(certbot python3-certbot-nginx)
  if command -v nginx >/dev/null 2>&1; then
    log "nginx already installed — leaving global nginx install/config alone"
  else
    pkgs+=(nginx)
  fi
  log "Installing packages if needed: ${pkgs[*]}"
  run_root apt-get update -y
  run_root apt-get install -y "${pkgs[@]}"
}

nginx_upstream_name() {
  local base
  base="$(printf '%s' "${APP_NAME}" | tr -c 'A-Za-z0-9_' '_')"
  base="$(printf '%s' "$base" | sed 's/^_*//;s/_*$//')"
  printf '%s_upstream' "${base:-url_checker}"
}

nginx_other_has_default_server() {
  local hits
  hits="$(
    run_root bash -c '
      shopt -s nullglob
      for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
        [[ -e "$f" ]] || continue
        base="$(basename "$f")"
        [[ "$base" == "'"${APP_NAME}"'.conf" ]] && continue
        if grep -Eq "listen[^;]*default_server" "$f" 2>/dev/null; then
          echo "$f"
        fi
      done
    ' 2>/dev/null || true
  )"
  [[ -n "$hits" ]]
}

ensure_http_site_for_acme() {
  # HTTP site for this app only (ACME + proxy). Does not remove other sites.
  local upstream listen_default
  upstream="$(nginx_upstream_name)"
  listen_default=""
  if nginx_other_has_default_server; then
    log "Another nginx site already uses default_server — not claiming it"
  else
    # Prefer Host-based routing; only use default_server when nothing else claims it
    # and we need ACME probes on bare IP to succeed.
    listen_default=" default_server"
  fi

  log "Writing HTTP nginx site for ACME (server_name=${DOMAIN} → 127.0.0.1:${PORT})"
  log "Other sites under /etc/nginx/sites-enabled/ are left in place"
  run_root mkdir -p "$WEBROOT"

  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__SERVER_NAME__|${DOMAIN}|g" \
    -e "s|__NGINX_PORT__|80|g" \
    -e "s|__APP_PORT__|${PORT}|g" \
    -e "s|__CLIENT_MAX_BODY__|${CLIENT_MAX_BODY}|g" \
    -e "s|__PROXY_READ_TIMEOUT__|${PROXY_READ_TIMEOUT}|g" \
    -e "s|__LISTEN_DEFAULT__|${listen_default}|g" \
    -e "s|__UPSTREAM_NAME__|${upstream}|g" \
    "$NGINX_HTTP_TEMPLATE" >"$tmp"

  # Append ACME webroot location before the closing brace of the server block
  python3 - "$tmp" "$WEBROOT" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
webroot = sys.argv[2]
text = path.read_text()
snippet = f"""
    location ^~ /.well-known/acme-challenge/ {{
        root {webroot};
        default_type "text/plain";
        allow all;
    }}
"""
if "acme-challenge" not in text:
    idx = text.rfind("}")
    if idx < 0:
        raise SystemExit("nginx template has no closing brace")
    text = text[:idx] + snippet + text[idx:]
    path.write_text(text)
PY

  if [[ -f "$NGINX_SITE_AVAILABLE" ]]; then
    run_root cp -a "$NGINX_SITE_AVAILABLE" "${NGINX_SITE_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)" || true
  fi

  run_root cp "$tmp" "$NGINX_SITE_AVAILABLE"
  run_root chmod 644 "$NGINX_SITE_AVAILABLE"
  rm -f "$tmp"

  run_root ln -sfn "$NGINX_SITE_AVAILABLE" "$NGINX_SITE_ENABLED"
  # Do NOT remove /etc/nginx/sites-enabled/default or any other site

  run_root nginx -t
  run_root systemctl enable nginx
  if systemctl is-active --quiet nginx; then
    run_root systemctl reload nginx
  else
    run_root systemctl start nginx
  fi

  # Sanity: webroot must be reachable for certbot
  run_root mkdir -p "${WEBROOT}/.well-known/acme-challenge"
  run_root bash -c "echo ok > '${WEBROOT}/.well-known/acme-challenge/setup-https-probe'"
  if curl -fsS -H "Host: ${DOMAIN}" \
    "http://127.0.0.1/.well-known/acme-challenge/setup-https-probe" >/dev/null 2>&1; then
    log "Local ACME webroot probe OK (Host: ${DOMAIN})"
  elif curl -fsS "http://127.0.0.1/.well-known/acme-challenge/setup-https-probe" >/dev/null 2>&1; then
    log "Local ACME webroot probe OK via default server"
  else
    log "WARNING: local ACME probe failed — check server_name=${DOMAIN} and that this site is enabled"
    log "  curl -v -H 'Host: ${DOMAIN}' http://127.0.0.1/.well-known/acme-challenge/setup-https-probe"
  fi
  run_root rm -f "${WEBROOT}/.well-known/acme-challenge/setup-https-probe"
}

# /etc/letsencrypt/live is usually root-only (0700) — never test -f as a normal user.
cert_exists() {
  local cert_dir="$1"
  run_root test -f "${cert_dir}/fullchain.pem" \
    && run_root test -f "${cert_dir}/privkey.pem"
}

# Prefer exact DOMAIN lineage; fall back to DOMAIN-000N if certbot created a suffix.
resolve_cert_dir() {
  local preferred="/etc/letsencrypt/live/${DOMAIN}"
  if cert_exists "$preferred"; then
    printf '%s' "$preferred"
    return 0
  fi

  local found=""
  # shellcheck disable=SC2012
  found="$(
    run_root bash -c "
      shopt -s nullglob
      for d in /etc/letsencrypt/live/${DOMAIN} /etc/letsencrypt/live/${DOMAIN}-*; do
        if [[ -f \"\$d/fullchain.pem\" && -f \"\$d/privkey.pem\" ]]; then
          echo \"\$d\"
        fi
      done
    " | sort | tail -n1
  )"
  if [[ -n "$found" ]]; then
    log "Using certificate lineage at ${found}"
    printf '%s' "$found"
    return 0
  fi
  return 1
}

obtain_certificate() {
  local cert_dir="/etc/letsencrypt/live/${DOMAIN}"
  if cert_exists "$cert_dir" && [[ "$FORCE_RENEW" -eq 0 ]]; then
    log "Certificate already present at ${cert_dir} (use --force-renew to renew)"
    return 0
  fi

  # Existing -000N lineage counts as present unless forcing renew
  if [[ "$FORCE_RENEW" -eq 0 ]] && resolve_cert_dir >/dev/null; then
    log "Certificate lineage already present for ${DOMAIN} (use --force-renew to renew)"
    return 0
  fi

  [[ -n "$CERTBOT_EMAIL" ]] || die "Set CERTBOT_EMAIL or pass --email for Let's Encrypt registration"

  local args=(
    certonly
    --webroot
    -w "$WEBROOT"
    -d "$DOMAIN"
    --cert-name "$DOMAIN"
    --non-interactive
    --agree-tos
    --email "$CERTBOT_EMAIL"
  )
  if [[ "$STAGING" -eq 1 ]]; then
    args+=(--staging)
    log "Using Let's Encrypt STAGING (test certificates)"
  fi
  if [[ "$FORCE_RENEW" -eq 1 ]]; then
    args+=(--force-renewal)
  fi

  log "Requesting certificate for ${DOMAIN}"
  if ! run_root certbot "${args[@]}"; then
    die "certbot failed. Common causes: DNS not pointing here, port 80 blocked, or ACME challenge not reachable.
  Debug:
    sudo certbot certificates
    sudo ls -la /etc/letsencrypt/live/
    curl -v -H 'Host: ${DOMAIN}' http://127.0.0.1/.well-known/acme-challenge/setup-https-probe
    curl -v http://${DOMAIN}/.well-known/acme-challenge/ (from outside)"
  fi

  if ! resolve_cert_dir >/dev/null; then
    log "certbot exited but no live cert found. Listing lineages:"
    run_root certbot certificates || true
    run_root ls -la /etc/letsencrypt/live/ || true
    die "Certificate not found after certbot under /etc/letsencrypt/live/${DOMAIN} (or ${DOMAIN}-*).
  If ACME failed, fix DNS/firewall and re-run.
  Note: live/ is root-only — this script now checks with sudo."
  fi
}

install_https_site() {
  local cert_dir
  cert_dir="$(resolve_cert_dir)" || die "Missing cert/key under /etc/letsencrypt/live/${DOMAIN}/"
  local cert="${cert_dir}/fullchain.pem"
  local key="${cert_dir}/privkey.pem"

  log "Installing HTTPS nginx site (443 + HTTP→HTTPS redirect)"
  log "SSL cert: ${cert}"
  log "Other nginx sites are not modified or removed"

  local upstream listen_default
  upstream="$(nginx_upstream_name)"
  listen_default=""
  if ! nginx_other_has_default_server; then
    listen_default=" default_server"
  fi

  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__SERVER_NAME__|${DOMAIN}|g" \
    -e "s|__APP_PORT__|${PORT}|g" \
    -e "s|__CLIENT_MAX_BODY__|${CLIENT_MAX_BODY}|g" \
    -e "s|__PROXY_READ_TIMEOUT__|${PROXY_READ_TIMEOUT}|g" \
    -e "s|__SSL_CERT__|${cert}|g" \
    -e "s|__SSL_KEY__|${key}|g" \
    -e "s|__UPSTREAM_NAME__|${upstream}|g" \
    -e "s|__LISTEN_DEFAULT__|${listen_default}|g" \
    "$NGINX_HTTPS_TEMPLATE" >"$tmp"

  if [[ -f "$NGINX_SITE_AVAILABLE" ]]; then
    run_root cp -a "$NGINX_SITE_AVAILABLE" "${NGINX_SITE_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)" || true
  fi

  run_root cp "$tmp" "$NGINX_SITE_AVAILABLE"
  run_root chmod 644 "$NGINX_SITE_AVAILABLE"
  rm -f "$tmp"

  run_root ln -sfn "$NGINX_SITE_AVAILABLE" "$NGINX_SITE_ENABLED"
  run_root nginx -t
  run_root systemctl reload nginx
}

enable_renewal_hook() {
  # Ensure nginx reloads after successful renewals
  local hook_dir="/etc/letsencrypt/renewal-hooks/deploy"
  local hook="${hook_dir}/reload-nginx.sh"
  log "Installing certbot deploy hook → reload nginx"
  run_root mkdir -p "$hook_dir"
  run_root tee "$hook" >/dev/null <<'EOF'
#!/usr/bin/env bash
systemctl reload nginx
EOF
  run_root chmod 755 "$hook"

  if systemctl list-unit-files 2>/dev/null | grep -q certbot.timer; then
    run_root systemctl enable --now certbot.timer || true
    log "certbot.timer enabled for automatic renewal"
  else
    log "Note: enable certbot renewal timer/cron per your distro if not already active"
  fi
}

main() {
  log "Domain: ${DOMAIN}"
  log "App upstream: 127.0.0.1:${PORT}"
  log "Email: ${CERTBOT_EMAIL:-'(missing — required for new certs)'}"

  need_cmd systemctl
  install_packages
  need_cmd nginx
  need_cmd certbot
  need_cmd python3

  if ! systemctl is-active --quiet nginx; then
    run_root systemctl start nginx
  fi

  ensure_http_site_for_acme
  obtain_certificate
  install_https_site
  enable_renewal_hook

  log "Done. Open https://${DOMAIN}/"
  log "Verify: curl -sI https://${DOMAIN}/"
  if [[ "$STAGING" -eq 1 ]]; then
    log "Staging certs are not trusted by browsers — re-run without --staging for production."
  fi
}

main
