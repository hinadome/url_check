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

1. Installs base OS packages via `apt-get` when available (`curl`, `git`, `build-essential`, …).
2. Ensures **Node.js ≥ 20** (installs NodeSource Node 20.x if needed).
3. Runs `npm ci --ignore-scripts` with Playwright browser download skipped (avoids OOM on small VMs).
4. Installs Playwright Chromium OS deps, then downloads Chromium in a separate step.
5. Runs `npm run build` (with a capped Node heap by default).
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
| `ENSURE_SWAP` | `1` | Auto-create/enable ~2G swap when RAM < 2 GB (`0` to disable) |
| `SWAP_SIZE` | `2G` | Size passed to `fallocate` when creating swap |
| `NODE_MAX_OLD_SPACE_SIZE` | `1536` | Node heap cap for `next build` (MB) unless `NODE_OPTIONS` is already set |

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
| `playwright install chromium` / `npm ci` **Killed** | Linux OOM killer — common on 1–2 GB VMs. Updated `deploy-vm.sh` skips browser download during `npm ci`, installs Chromium separately, and may add swap when RAM < 2 GB. Re-pull and re-run `./scripts/deploy-vm.sh`. Disable auto-swap with `ENSURE_SWAP=0`. |
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
- Put TLS termination (nginx, Caddy, cloud LB) in front of port 3000 in production.
- Keep Playwright / base image versions updated with dependency upgrades.

---

## Related docs

- App overview and API: [README.md](README.md)
- Change history: [CHANGELOG.md](CHANGELOG.md)
