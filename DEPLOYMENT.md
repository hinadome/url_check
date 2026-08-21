# Deployment guide — URL Checker

This app is **Next.js + Playwright Chromium**. It needs a real Node.js environment that can launch a browser. Prefer a **VM** or **container** for production checks. Vercel/Netlify remain optional for UI-only experiments; see [README.md](README.md#deployment-vercel--netlify).

| Target | Script | Best for |
|--------|--------|----------|
| **VM** | [`scripts/deploy-vm.sh`](scripts/deploy-vm.sh) | Ubuntu/Debian servers, systemd service |
| **Container** | [`scripts/deploy-container.sh`](scripts/deploy-container.sh) | Docker / Compose anywhere |

Related files:

| File | Purpose |
|------|---------|
| [`deploy/url-checker.service`](deploy/url-checker.service) | systemd unit template used by the VM script |
| [`deploy/nginx-url-checker.conf`](deploy/nginx-url-checker.conf) | nginx reverse-proxy site template (HTTP front → Next.js) |
| [`deploy/nginx-url-checker-https.conf`](deploy/nginx-url-checker-https.conf) | nginx HTTPS site template (TLS + HTTP→HTTPS redirect) |
| [`scripts/setup-https.sh`](scripts/setup-https.sh) | Post-deploy Let's Encrypt cert + HTTPS nginx config (domain required) |
| [`Dockerfile`](Dockerfile) | Production image (Playwright base + Next.js) |
| [`docker-compose.yml`](docker-compose.yml) | One-service Compose stack (`shm_size` for Chromium) |
| [`vercel.json`](vercel.json) / [`netlify.toml`](netlify.toml) | Optional serverless UI hosting (Playwright often unreliable) |
| [`.github/workflows/deploy-vm-ssh.yml`](.github/workflows/deploy-vm-ssh.yml) | **Manual** GitHub Actions deploy to a VM over SSH |

---

## Prerequisites (both)

- App source checked out on the host
- Outbound network for `npm ci` and Playwright browser download (first install)
- Open TCP port for the app (default **3000**)
- Enough RAM for Chromium (recommend **≥ 2 GB** free; **4 GB+** preferred under load)

---

## 1. VM deployment (`deploy-vm.sh`)

### What the script does

1. Installs base OS packages via `apt-get` when available (`curl`, `git`, `build-essential`; **nginx** only if missing and not `--no-nginx`).
2. Ensures **Node.js ≥ 20** (installs NodeSource Node 20.x if needed).
3. Runs `npm ci --ignore-scripts` with Playwright browser download skipped (avoids OOM on small VMs).
4. Installs Playwright Chromium OS deps, then downloads Chromium in a separate step.
5. Runs `npm run build` (with a capped Node heap by default).
6. Unless `--build-only` / `--no-systemd`:
   - Writes `/etc/systemd/system/url-checker.service` from [`deploy/url-checker.service`](deploy/url-checker.service)
   - When nginx is enabled (default): Next.js binds to **`127.0.0.1:$PORT`** only
   - Writes/updates **only** `/etc/nginx/sites-available/url-checker.conf` (does not remove other sites)
   - Reloads nginx when already running; restarts the app unit
   - Or falls back to foreground `npm start` if systemd is missing (nginx skipped)

### Updating the app (re-run)

After `git pull` (or your usual sync), re-run the same script on the VM:

```bash
./scripts/deploy-vm.sh
```

That path is idempotent for updates: stops `url-checker` if running, runs `npm ci` + Playwright Chromium install + `npm run build`, rewrites/restarts the systemd unit, and leaves other nginx sites alone (skips rewriting this app’s site when unchanged; preserves HTTPS site files from `setup-https.sh`).

### Requirements

- **Ubuntu/Debian**-style host with `apt-get` recommended (other distros: install Node 20+ and Chromium deps yourself, then use `--build-only` + manual process manager).
- `sudo` (or root) for apt, Playwright deps, and systemd unit install.
- Shell: `bash`.

### Usage

```bash
cd /path/to/url_checker
chmod +x scripts/deploy-vm.sh

# Full deploy: build + systemd + nginx on port 80 → app on 3000
./scripts/deploy-vm.sh

# Custom port / service user
PORT=8080 APP_USER=ubuntu ./scripts/deploy-vm.sh

# Public URL hint + nginx server_name from host
APP_URL=https://checker.example.com ./scripts/deploy-vm.sh

# Skip nginx (expose Next.js directly on PORT)
./scripts/deploy-vm.sh --no-nginx

# Install and build only (no service start)
./scripts/deploy-vm.sh --build-only

# Skip systemd; run Next in the foreground (nginx not installed)
./scripts/deploy-vm.sh --no-systemd
```

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Listen port for `next start` / systemd (loopback when nginx is on) |
| `APP_URL` | _(empty)_ | Optional public origin to print after deploy; must be `http://` or `https://`; host used as nginx `server_name` when `SERVER_NAME` unset |
| `SERVER_NAME` | host of `APP_URL`, else `_` | nginx `server_name` |
| `NGINX_PORT` | `80` | Public HTTP port nginx listens on |
| `CLIENT_MAX_BODY` | `50m` | nginx `client_max_body_size` (large JSON / uploads) |
| `PROXY_READ_TIMEOUT` | `120s` | nginx `proxy_read_timeout` / `proxy_send_timeout` (Playwright checks) |
| `APP_USER` | current user | systemd `User=` |
| `APP_NAME` | `url-checker` | systemd unit + nginx site name |
| `NODE_MAJOR` | `20` | Minimum / install major Node version |
| `ENSURE_SWAP` | `1` | Auto-create/enable ~2G swap when RAM < 2 GB (`0` to disable) |
| `SWAP_SIZE` | `2G` | Size passed to `fallocate` when creating swap |
| `NODE_MAX_OLD_SPACE_SIZE` | `1536` | Node heap cap for `next build` (MB) unless `NODE_OPTIONS` is already set |

### systemd lifecycle

```bash
sudo systemctl status url-checker
sudo systemctl restart url-checker
sudo journalctl -u url-checker -f
```

Unit template placeholders replaced at install time: `__APP_DIR__`, `__APP_USER__`, `__PORT__`, `__HOST__`, `__NODE_BIN__`.

### nginx front proxy (default)

By default the VM script installs **nginx** only if it is missing, then manages **only** the URL Checker site file. Existing sites under `/etc/nginx/sites-enabled/` are **not** removed (including `default`).

| Piece | Path / behavior |
|-------|-----------------|
| Template | [`deploy/nginx-url-checker.conf`](deploy/nginx-url-checker.conf) |
| Managed site | `/etc/nginx/sites-available/url-checker.conf` → symlink in `sites-enabled` |
| Upstream | `http://127.0.0.1:$PORT` (unique upstream name derived from `APP_NAME`) |
| Public listen | `$NGINX_PORT` (default **80**) |
| `default_server` | Used only when no other enabled site already claims it **and** `server_name` is `_` |
| Stock `default` site | Left alone if nginx was already installed; disabled only on a **fresh** nginx install by this script (or `NGINX_DISABLE_DEFAULT=1`) |
| App bind | `127.0.0.1:$PORT` when nginx is enabled; `0.0.0.0:$PORT` with `--no-nginx` |
| Existing TLS site | If our site file already has `ssl_certificate`, deploy **leaves it unchanged** (refresh via `setup-https.sh`) |
| Reload | `nginx -t` + `systemctl reload` when nginx is already running (not a full restart) |

On shared hosts, set an explicit hostname so Host-based routing works:

```bash
SERVER_NAME=checker.example.com APP_URL=https://checker.example.com ./scripts/deploy-vm.sh
```

```bash
sudo nginx -t
sudo systemctl status nginx
sudo systemctl reload nginx
curl -sI "http://127.0.0.1:${NGINX_PORT:-80}/"
```

**HTTPS:** after HTTP deploy, run [`scripts/setup-https.sh`](scripts/setup-https.sh) with your domain (Let's Encrypt + nginx 443). Or terminate TLS on a cloud load balancer and set `APP_URL=https://your.domain`.

Skip nginx entirely:

```bash
./scripts/deploy-vm.sh --no-nginx
```

### HTTPS with Let's Encrypt (`setup-https.sh`)

Run **after** a successful VM deploy with nginx. The domain's DNS must already point at this VM; ports **80** and **443** must be open.

```bash
cd /path/to/url_checker
chmod +x scripts/setup-https.sh

# Domain is required; email for Let's Encrypt registration
./scripts/setup-https.sh checker.example.com --email ops@example.com
# or: CERTBOT_EMAIL=ops@example.com ./scripts/setup-https.sh checker.example.com

# Optional: staging CA (untrusted test certs)
./scripts/setup-https.sh checker.example.com --email ops@example.com --staging

# Force renew / replace cert
./scripts/setup-https.sh checker.example.com --email ops@example.com --force-renew
```

What it does:

1. Installs `certbot` + `python3-certbot-nginx` (and nginx if missing).
2. Writes an HTTP site with `server_name=<domain>` and an ACME webroot at `/var/www/certbot`.
3. Obtains a certificate via `certbot certonly --webroot` for that domain.
4. Installs [`deploy/nginx-url-checker-https.conf`](deploy/nginx-url-checker-https.conf): **443 SSL** reverse proxy + **80 → HTTPS** redirect (ACME path kept on :80).
5. Adds a certbot deploy hook to `reload nginx` and enables `certbot.timer` when available.

| Variable / flag | Default | Meaning |
|-----------------|---------|---------|
| domain (positional) | _(required)_ | Certificate / nginx `server_name` |
| `--email` / `CERTBOT_EMAIL` | _(required for new certs)_ | Let's Encrypt account email |
| `--staging` | off | Use Let's Encrypt staging |
| `--force-renew` | off | Force certificate renewal |
| `PORT` | `3000` | Upstream Next.js port (`127.0.0.1`) |
| `APP_NAME` | `url-checker` | nginx site filename |
| `CLIENT_MAX_BODY` | `50m` | nginx body size |
| `PROXY_READ_TIMEOUT` | `120s` | nginx proxy timeouts |

```bash
curl -sI "https://checker.example.com/"
sudo certbot renew --dry-run
```

### Verify

```bash
# Via nginx (default deploy)
curl -sI "http://127.0.0.1:${NGINX_PORT:-80}/"
# Direct to the app (loopback when nginx is on)
curl -sI "http://127.0.0.1:${PORT:-3000}/"
# Open UI, run a check against https://example.com
```

### Troubleshooting (VM)

| Issue | What to try |
|-------|-------------|
| `playwright install chromium` / `npm ci` **Killed** | Linux OOM killer — common on 1–2 GB VMs. Updated `deploy-vm.sh` skips browser download during `npm ci`, installs Chromium separately, and may add swap when RAM < 2 GB. Re-pull and re-run `./scripts/deploy-vm.sh`. Disable auto-swap with `ENSURE_SWAP=0`. |
| `playwright install-deps` fails | Run as root/sudo; on non-Debian install Chromium system libraries manually from Playwright docs |
| Service exits immediately | `journalctl -u url-checker -e`; confirm `WorkingDirectory` and Node path |
| Checks timeout / OOM | Add RAM; lower concurrent use; ensure `/dev/shm` is reasonably sized |
| Port in use | `PORT=8080 ./scripts/deploy-vm.sh` or change existing service |
| nginx fails `nginx -t` / port 80 busy | `sudo nginx -t`; stop other web servers; or `NGINX_PORT=8080 ./scripts/deploy-vm.sh`; or `--no-nginx` |
| App reachable on :3000 but not :80 | Check `systemctl status nginx`; firewall/security group must allow **80** (and **443** after certbot) |
| `setup-https` “Certificate not found after certbot” | Often a **false negative**: `/etc/letsencrypt/live` is root-only, so a non-root `test -f` fails. Current script checks with `sudo`. Re-pull and re-run. Also verify: `sudo ls -la /etc/letsencrypt/live/`, `sudo certbot certificates`, DNS A record, port 80 from the internet, and ACME path `http://<domain>/.well-known/acme-challenge/` |

---

## 2. Container deployment (`deploy-container.sh`)

### What the script does

1. Checks for `docker` and `docker compose` (or `docker-compose`).
2. Builds the image from [`Dockerfile`](Dockerfile) (Playwright `noble` image + `npm ci` + `next build`).
3. Starts Compose service `url-checker` detached (`up -d --build`).
4. Waits until the app responds over **HTTP or HTTPS** on `127.0.0.1:$PORT` (or optional `APP_URL`), or prints log hints.

Supporting Compose settings:

- Host port `${PORT:-3000}` → container `3000`
- `shm_size: 1gb` (Chromium needs shared memory)
- Healthcheck against `/`
- `restart: unless-stopped`

### Requirements

- Docker Engine with Compose v2 (`docker compose`) or classic `docker-compose`
- Permission to talk to the Docker daemon
- Disk for image layers (Playwright base image is large)

### Usage

```bash
cd /path/to/url_checker
chmod +x scripts/deploy-container.sh

# Build and start (default host port 3000)
./scripts/deploy-container.sh

# Custom host port
PORT=8080 ./scripts/deploy-container.sh

# Public URL for health hint / optional probe (http or https)
APP_URL=https://checker.example.com ./scripts/deploy-container.sh

# Force clean rebuild
./scripts/deploy-container.sh --build

# Follow logs
./scripts/deploy-container.sh --logs

# Stop and remove containers
./scripts/deploy-container.sh --down
```

Equivalent Compose commands:

```bash
PORT=3000 docker compose up -d --build
docker compose logs -f url-checker
docker compose down
```

### Dockerfile notes

- Base: `mcr.microsoft.com/playwright:v1.62.1-noble` (keep in sync with `playwright` in `package.json` / Compose build arg `PLAYWRIGHT_VERSION`).
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` uses browsers from the base image.
- Build runs `npm run build` then `npm prune --omit=dev`.
- Runtime: `npm start -- -p 3000`.

### Verify

```bash
curl -sI "http://127.0.0.1:${PORT:-3000}/"
# or: curl -skI "https://127.0.0.1:${PORT:-3000}/"
docker compose ps
docker compose logs --tail=100 url-checker
```

### Troubleshooting (container)

| Issue | What to try |
|-------|-------------|
| Browser crash / target closed | Ensure Compose `shm_size` is set (already `1gb`); avoid tiny Docker Desktop RAM limits |
| Build very slow / large pull | Expected for Playwright base images; cache helps on rebuilds |
| Port conflict | `PORT=8080 ./scripts/deploy-container.sh` |
| Healthcheck failing | `./scripts/deploy-container.sh --logs`; confirm app finished compiling/start |

---

## Choosing VM vs container

| Prefer **VM script** when… | Prefer **container script** when… |
|----------------------------|-----------------------------------|
| You manage a single Ubuntu/Debian server with systemd | You already run Docker in prod/dev |
| You want OS-level service integration | You want reproducible images and easy rollback |
| You need to debug Playwright OS libraries on the host | You want isolation from the host Node version |

Both approaches support real Chromium and are suitable for `/api/check`. Serverless (Vercel/Netlify) is not a substitute for these for reliable Playwright execution.

---

## 3. GitHub Actions → VM over SSH (manual only)

Workflow: [`.github/workflows/deploy-vm-ssh.yml`](.github/workflows/deploy-vm-ssh.yml)

- **Trigger:** `workflow_dispatch` only (Actions UI → **Deploy VM (SSH)** → **Run workflow**).
- **Does not** run on `push`, `pull_request`, or schedule.
- SSHes into the VM, updates the git checkout, then runs [`scripts/deploy-vm.sh`](scripts/deploy-vm.sh).

### One-time VM setup

1. Clone the repo on the server (deploy path must already be a git working tree):

   ```bash
   sudo mkdir -p /opt/url_checker
   sudo chown "$USER":"$USER" /opt/url_checker
   git clone git@github.com:<org>/<repo>.git /opt/url_checker
   # or HTTPS clone with a deploy key / credential helper
   ```

2. Ensure the SSH user can run the deploy script (Node/npm, and preferably passwordless `sudo` for apt / systemd / Playwright deps — same as local VM deploy).

3. Confirm a manual deploy works once:

   ```bash
   cd /opt/url_checker
   ./scripts/deploy-vm.sh
   ```

4. Allow the GitHub Actions runner to reach the VM on the SSH port (firewall / security group).

### GitHub repository secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Required | Description |
|--------|----------|-------------|
| `VM_SSH_HOST` | Yes | VM hostname or IP |
| `VM_SSH_USER` | Yes | SSH username |
| `VM_SSH_PRIVATE_KEY` | Yes | Private key (PEM) whose public key is in `~/.ssh/authorized_keys` on the VM |
| `VM_DEPLOY_PATH` | Yes | Absolute path to the git checkout (e.g. `/opt/url_checker`) |
| `VM_SSH_PORT` | No | SSH port (default **22** if unset/empty) |
| `VM_APP_PORT` | No | App `PORT` for `deploy-vm.sh` (default **3000**) |
| `VM_APP_USER` | No | systemd service user (`APP_USER`); defaults to SSH user on the script side if empty |
| `VM_APP_URL` | No | Optional `APP_URL` for `deploy-vm.sh` (`http://` or `https://` public origin) |

Use a **dedicated deploy key** with the least privilege needed (repo read on the VM clone remote; SSH login limited to deploy).

### How to run (manual hook)

1. Push the code you want deployed to GitHub (so the VM can `git fetch` it).
2. Open the repo on GitHub → **Actions**.
3. Select workflow **Deploy VM (SSH)**.
4. Click **Run workflow**.
5. Choose the branch (used when `git_ref` is left empty).
6. Optional inputs:
   - **git_ref** — branch / tag / SHA to check out on the VM (empty = branch selected in the UI).
   - **skip_deploy_script** — only update git; skip `./scripts/deploy-vm.sh`.
7. Run and watch the job log.

### What the workflow runs remotely

```text
cd $VM_DEPLOY_PATH
git fetch --prune origin
git checkout <ref>
./scripts/deploy-vm.sh    # unless skip_deploy_script=true
```

### Notes / limits

- Concurrency group `deploy-vm-ssh` prevents overlapping deploys (new runs wait; in-progress is not cancelled).
- Job timeout is 45 minutes (Playwright install + build can be slow on first run).
- The workflow does **not** build in GitHub-hosted runners for production; build happens **on the VM** via `deploy-vm.sh`.
- If `git fetch` fails, fix remotes/credentials on the VM (SSH deploy key to GitHub, or HTTPS token).

---

## Security reminders

- Do not expose an open checker to the public internet without auth and rate limits (SSRF risk even with current guards).
- VM deploy installs **nginx on port 80** by default and binds the app to localhost; enable TLS with [`scripts/setup-https.sh`](scripts/setup-https.sh) `<domain>` (or a cloud LB) before production use.
- Keep Playwright / base image versions updated with dependency upgrades.

---

## Related docs

- App overview and API: [README.md](README.md)
- Change history: [CHANGELOG.md](CHANGELOG.md)
