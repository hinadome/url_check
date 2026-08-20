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
| [`Dockerfile`](Dockerfile) | Production image (Playwright base + Next.js) |
| [`docker-compose.yml`](docker-compose.yml) | One-service Compose stack (`shm_size` for Chromium) |
| [`vercel.json`](vercel.json) / [`netlify.toml`](netlify.toml) | Optional serverless UI hosting (Playwright often unreliable) |

---

## Prerequisites (both)

- App source checked out on the host
- Outbound network for `npm ci` and Playwright browser download (first install)
- Open TCP port for the app (default **3000**)
- Enough RAM for Chromium (recommend **≥ 2 GB** free; **4 GB+** preferred under load)

---

## 1. VM deployment (`deploy-vm.sh`)

### What the script does

1. Installs base OS packages via `apt-get` when available (`curl`, `git`, `build-essential`, …).
2. Ensures **Node.js ≥ 20** (installs NodeSource Node 20.x if needed).
3. Runs `npm ci`.
4. Installs Playwright Chromium OS deps (`playwright install-deps`) when possible, then `playwright install chromium`.
5. Runs `npm run build`.
6. Unless `--build-only` / `--no-systemd`:
   - Writes `/etc/systemd/system/url-checker.service` from [`deploy/url-checker.service`](deploy/url-checker.service)
   - `daemon-reload`, `enable`, `restart`
   - Or falls back to foreground `npm start` if systemd is missing

### Requirements

- **Ubuntu/Debian**-style host with `apt-get` recommended (other distros: install Node 20+ and Chromium deps yourself, then use `--build-only` + manual process manager).
- `sudo` (or root) for apt, Playwright deps, and systemd unit install.
- Shell: `bash`.

### Usage

```bash
cd /path/to/url_checker
chmod +x scripts/deploy-vm.sh

# Full deploy: build + systemd service on port 3000
./scripts/deploy-vm.sh

# Custom port / service user
PORT=8080 APP_USER=ubuntu ./scripts/deploy-vm.sh

# Install and build only (no service start)
./scripts/deploy-vm.sh --build-only

# Skip systemd; run Next in the foreground
./scripts/deploy-vm.sh --no-systemd
```

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Listen port for `next start` / systemd |
| `APP_USER` | current user | systemd `User=` |
| `APP_NAME` | `url-checker` | systemd unit name (`url-checker.service`) |
| `NODE_MAJOR` | `20` | Minimum / install major Node version |

### systemd lifecycle

```bash
sudo systemctl status url-checker
sudo systemctl restart url-checker
sudo journalctl -u url-checker -f
```

Unit template placeholders replaced at install time: `__APP_DIR__`, `__APP_USER__`, `__PORT__`, `__NODE_BIN__`.

### Verify

```bash
curl -sI "http://127.0.0.1:${PORT:-3000}/"
# Open UI, run a check against https://example.com
```

### Troubleshooting (VM)

| Issue | What to try |
|-------|-------------|
| `playwright install-deps` fails | Run as root/sudo; on non-Debian install Chromium system libraries manually from Playwright docs |
| Service exits immediately | `journalctl -u url-checker -e`; confirm `WorkingDirectory` and Node path |
| Checks timeout / OOM | Add RAM; lower concurrent use; ensure `/dev/shm` is reasonably sized |
| Port in use | `PORT=8080 ./scripts/deploy-vm.sh` or change existing service |

---

## 2. Container deployment (`deploy-container.sh`)

### What the script does

1. Checks for `docker` and `docker compose` (or `docker-compose`).
2. Builds the image from [`Dockerfile`](Dockerfile) (Playwright `noble` image + `npm ci` + `next build`).
3. Starts Compose service `url-checker` detached (`up -d --build`).
4. Waits until `http://127.0.0.1:$PORT/` responds (or prints log hints).

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

## Security reminders

- Do not expose an open checker to the public internet without auth and rate limits (SSRF risk even with current guards).
- Put TLS termination (nginx, Caddy, cloud LB) in front of port 3000 in production.
- Keep Playwright / base image versions updated with dependency upgrades.

---

## Related docs

- App overview and API: [README.md](README.md)
- Change history: [CHANGELOG.md](CHANGELOG.md)
