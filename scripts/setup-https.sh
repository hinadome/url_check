#!/usr/bin/env bash
# Configure nginx for HTTPS after URL Checker has been deployed on a VM
# (deploy-vm.sh). Two certificate modes:
#   1. Let's Encrypt (default): ACME webroot via certbot — needs public DNS + ports.
#   2. Self-signed (--self-signed): openssl-generated cert — no DNS/ACME needed.
#      Good for internal hosts, IP-only VMs, dev/test. Browsers will warn (untrusted).
#
# Usage:
#   # Let's Encrypt (default)
#   ./scripts/setup-https.sh checker.example.com --email ops@example.com
#   CERTBOT_EMAIL=ops@example.com ./scripts/setup-https.sh checker.example.com
#   ./scripts/setup-https.sh checker.example.com --staging       # LE staging
#   ./scripts/setup-https.sh checker.example.com --force-renew
#
#   # Self-signed (no ACME, no email, no public DNS required)
#   ./scripts/setup-https.sh checker.example.com --self-signed
#   ./scripts/setup-https.sh 203.0.113.10 --self-signed          # IP-only host
#   ./scripts/setup-https.sh internal.lan --self-signed --san DNS:alt.lan --san IP:10.0.0.5
#   ./scripts/setup-https.sh internal.lan --self-signed --force-renew   # regenerate
#
# Prerequisites (Let's Encrypt mode):
#   - DNS A/AAAA for DOMAIN → this VM's public IP
#   - Ports 80 and 443 reachable from the internet
#   - App already deployed with nginx (./scripts/deploy-vm.sh)
#
# Prerequisites (self-signed mode):
#   - openssl installed (auto-installed on apt systems)
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
SELF_SIGNED=0
SELF_SIGNED_DAYS="${SELF_SIGNED_DAYS:-825}"
SELF_SIGNED_DIR_BASE="${SELF_SIGNED_DIR_BASE:-/etc/ssl/url-checker}"
EXTRA_SANS=()
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
  sed -n '2,27p' "$0"
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
    --self-signed)
      SELF_SIGNED=1
      ;;
    --san)
      shift
      [[ $# -gt 0 ]] || die "--san requires a value (e.g. DNS:alt.example.com or IP:10.0.0.5)"
      EXTRA_SANS+=("$1")
      ;;
    --san=*)
      EXTRA_SANS+=("${1#--san=}")
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

# Self-signed mode allows bare IPv4 (common for IP-only VMs); LE does not issue for IPs.
is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

# Basic domain sanity (hostname labels or, in self-signed mode, a bare IPv4)
if is_ipv4 "$DOMAIN"; then
  if [[ "$SELF_SIGNED" -ne 1 ]]; then
    die "Let's Encrypt cannot issue for a bare IP (${DOMAIN}); use --self-signed for IP hosts"
  fi
elif ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  die "Invalid domain name: ${DOMAIN}"
fi
if [[ "$DOMAIN" == *"*"* ]]; then
  die "Wildcard domains are not supported by this script"
fi

# Option-conflict sanity for self-signed mode.
if [[ "$SELF_SIGNED" -eq 1 ]]; then
  if [[ "$STAGING" -eq 1 ]]; then
    die "--staging only applies to Let's Encrypt; drop it with --self-signed"
  fi
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    log "Note: --email is ignored in --self-signed mode"
  fi
fi

[[ -f "$NGINX_HTTPS_TEMPLATE" ]] || die "Missing template: $NGINX_HTTPS_TEMPLATE"
[[ -f "$NGINX_HTTP_TEMPLATE" ]] || die "Missing template: $NGINX_HTTP_TEMPLATE"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

install_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    if [[ "$SELF_SIGNED" -eq 1 ]]; then
      # Self-signed only needs openssl + nginx, which may already be present.
      log "apt-get not found — skipping package install (ensure nginx + openssl exist)"
      return 0
    fi
    die "apt-get not found — this script targets Ubuntu/Debian"
  fi

  local pkgs=()
  if [[ "$SELF_SIGNED" -eq 1 ]]; then
    # No certbot/ACME needed for self-signed; openssl generates the cert.
    command -v openssl >/dev/null 2>&1 || pkgs+=(openssl)
  else
    pkgs+=(certbot python3-certbot-nginx)
  fi
  if command -v nginx >/dev/null 2>&1; then
    log "nginx already installed — leaving global nginx install/config alone"
  else
    pkgs+=(nginx)
  fi
  if [[ "${#pkgs[@]}" -eq 0 ]]; then
    log "Required packages already installed — nothing to install"
    return 0
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

# Directory holding the self-signed cert for this domain.
self_signed_cert_dir() {
  printf '%s/%s' "$SELF_SIGNED_DIR_BASE" "$DOMAIN"
}

# Generate a self-signed cert + key with a SAN covering DOMAIN (and extras).
# Mirrors the Let's Encrypt file names (fullchain.pem / privkey.pem) so the
# HTTPS nginx template is reused unchanged.
generate_self_signed_cert() {
  need_cmd openssl
  local cert_dir cert key
  cert_dir="$(self_signed_cert_dir)"
  cert="${cert_dir}/fullchain.pem"
  key="${cert_dir}/privkey.pem"

  if cert_exists "$cert_dir" && [[ "$FORCE_RENEW" -eq 0 ]]; then
    log "Self-signed certificate already present at ${cert_dir} (use --force-renew to regenerate)"
    return 0
  fi

  # Build subjectAltName: DOMAIN as IP or DNS, plus any --san entries verbatim.
  local -a sans=()
  if is_ipv4 "$DOMAIN"; then
    sans+=("IP:${DOMAIN}")
  else
    sans+=("DNS:${DOMAIN}")
  fi
  local extra
  for extra in "${EXTRA_SANS[@]:-}"; do
    [[ -n "$extra" ]] || continue
    # Accept raw "DNS:x" / "IP:x", or bare host/IP (auto-prefix).
    case "$extra" in
      DNS:*|IP:*) sans+=("$extra") ;;
      *) if is_ipv4 "$extra"; then sans+=("IP:${extra}"); else sans+=("DNS:${extra}"); fi ;;
    esac
  done

  local san_csv
  san_csv="$(IFS=,; printf '%s' "${sans[*]}")"
  log "Generating self-signed certificate for ${DOMAIN}"
  log "  SAN: ${san_csv}"
  log "  Validity: ${SELF_SIGNED_DAYS} days  Dir: ${cert_dir}"

  run_root mkdir -p "$cert_dir"
  run_root chmod 755 "$SELF_SIGNED_DIR_BASE" || true

  # openssl can take -addext (1.1.1+); write cert directly to the target paths.
  if ! run_root openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$key" \
      -out "$cert" \
      -days "$SELF_SIGNED_DAYS" \
      -subj "/CN=${DOMAIN}" \
      -addext "subjectAltName=${san_csv}" 2>/dev/null; then
    # Fallback for older openssl without -addext: use a temp config file.
    log "openssl -addext unsupported; falling back to a temp config"
    local cfg
    cfg="$(mktemp)"
    cat >"$cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${DOMAIN}
[v3]
subjectAltName = ${san_csv}
EOF
    run_root openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$key" \
      -out "$cert" \
      -days "$SELF_SIGNED_DAYS" \
      -config "$cfg"
    rm -f "$cfg"
  fi

  run_root chmod 600 "$key"
  run_root chmod 644 "$cert"
  cert_exists "$cert_dir" || die "Self-signed cert generation failed under ${cert_dir}"
  log "Self-signed certificate created"
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
  if [[ "$SELF_SIGNED" -eq 1 ]]; then
    cert_dir="$(self_signed_cert_dir)"
    cert_exists "$cert_dir" || die "Missing self-signed cert/key under ${cert_dir}/"
  else
    cert_dir="$(resolve_cert_dir)" || die "Missing cert/key under /etc/letsencrypt/live/${DOMAIN}/"
  fi
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

  need_cmd systemctl
  install_packages
  need_cmd nginx

  if ! systemctl is-active --quiet nginx; then
    run_root systemctl start nginx
  fi

  if [[ "$SELF_SIGNED" -eq 1 ]]; then
    log "Mode: self-signed (no ACME, no public DNS required)"
    generate_self_signed_cert
    install_https_site
    log "Done. Open https://${DOMAIN}/"
    log "Verify: curl -skI https://${DOMAIN}/   (-k: self-signed is not CA-trusted)"
    log "Browsers will warn about an untrusted certificate — this is expected for self-signed."
    log "Regenerate later with: ${0} ${DOMAIN} --self-signed --force-renew"
    return 0
  fi

  log "Mode: Let's Encrypt"
  log "Email: ${CERTBOT_EMAIL:-'(missing — required for new certs)'}"
  need_cmd certbot
  need_cmd python3

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
