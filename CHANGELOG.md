# Changelog

All notable changes to **URL Checker** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

### Added

- **Light / dark mode** toggle in the header (`ThemeProvider` + `ThemeToggle`): persists in `localStorage` (`url-checker-theme`), defaults to system preference, applies `data-theme` on `<html>` (FOUC-prevention script in `app/layout.tsx`).
- Network **Remote IP** (`remoteIp` / `remotePort` via `response.serverAddr()`) and **HTTP** (`httpVersion` via `response.httpVersion()`) columns.
- Network row **Timing** tab: per-request Resource Timing (`request.timing()` → `timing`) plus page **Navigation Timing** on document rows (`navigationTiming` on the check result).
- Timing tab **waterfall graph** (`components/TimingWaterfall.tsx`): stacked + per-phase bars for Resource timing; Navigation waterfall on document rows; **Queueing / stalled** segments fill timeline gaps (documented in README).
- **Date** column on Network requests (`date` ISO timestamp when each response was observed; rows sorted chronologically).
- Network requests panel **Expand width** / **Collapse width** control for near-full viewport width.
- Network panel default layout **breaks out** of the main form column (wider than 960px) so the table has room to breathe.
- Network requests **filter bar** (`components/NetworkRequestsPanel.tsx`):
  - **URL contains** — case-insensitive substring search
  - **Remote host**, **Status**, **Type**, **Content type** — dropdowns populated from the current result set
  - **Clear filters** when any filter is active
  - Subtitle **Showing N of M responses (filtered)**
  - Empty-filter message when nothing matches
  - Filters combine with AND; panel remounts on each new check (`key` on `app/page.tsx`) so controls reset
- Per-network-entry **request headers** and **response headers** (expand row; tabbed view)
- Network row **Content** tab (`lib/network-collector.ts` + `HeadersTabs`):
  - `bodyEncoding: "text"` → plain-text body (Full content–style `<pre>`)
  - `bodyEncoding: "base64"` → binary body as base64 (with note)
  - `bodyEncoding: "empty"` → Content tab shows nothing
  - Fields: `body`, `bodyEncoding`, `bodyTruncated`; capture cap ~512KB
  - Binary detection via content-type heuristics and null-byte sampling
- Shared **`HeadersTabs`** for Request / Response / Content / Timing (`components/HeadersTabs.tsx`)
- Main **HTTP headers** panel uses Request / Response only (no Content or Timing tab)
- **Export** menu on the results meta strip (`components/ExportMenu.tsx`, `lib/export.ts`):
  - **JSON (light)** — recommended; strips screenshot + network bodies; **keeps** `timing` / `navigationTiming` and other network metadata
  - **JSON (full)** — complete payload including screenshot, bodies, and all timing fields
  - **Screenshot (PNG)**, **HTML source**
  - **Network CSV (index)** — metadata columns only (includes remote IP / HTTP version; no header maps, bodies, or full timing maps)
- Deploy configs for **Vercel** (`vercel.json`) and **Netlify** (`netlify.toml`) with Next.js native hosting; README documents Playwright serverless limits
- **VM** and **container** deploy scripts plus [`DEPLOYMENT.md`](DEPLOYMENT.md): `scripts/deploy-vm.sh`, `scripts/deploy-container.sh`, `Dockerfile`, `docker-compose.yml`, `deploy/url-checker.service`, `deploy/nginx-url-checker.conf`
- GitHub Actions **manual** SSH VM deploy: [`.github/workflows/deploy-vm-ssh.yml`](.github/workflows/deploy-vm-ssh.yml) (`workflow_dispatch` only); optional `VM_APP_URL` secret
- VM deploy script avoids OOM during `npm ci` by skipping Playwright postinstall / browser download, installing Chromium separately, and optionally enabling swap on low-RAM hosts
- VM **nginx** front proxy (default on full systemd deploy): public HTTP (`NGINX_PORT`, default 80) → `127.0.0.1:$PORT`; `--no-nginx` to expose the app directly; env knobs `SERVER_NAME`, `CLIENT_MAX_BODY`, `PROXY_READ_TIMEOUT`
- Post-deploy **HTTPS** script [`scripts/setup-https.sh`](scripts/setup-https.sh): domain parameter + Let's Encrypt (`certbot`) + nginx TLS site from [`deploy/nginx-url-checker-https.conf`](deploy/nginx-url-checker-https.conf) (HTTP→HTTPS redirect, renewal hook)
- `setup-https.sh` checks certificate files with **sudo** (fixes false “Certificate not found” when `/etc/letsencrypt/live` is root-only); uses `--cert-name`, resolves `domain-000N` lineages, and probes the ACME webroot

### Changed

- Header viewing UX: replaced side-by-side request/response tables with **Request** / **Response** tabs (full-width table per tab; default Response).
- Header **name** column sizing tightened (~12rem fixed in network detail) so keys are not far from values on wide panels.
- Network list uses **`table-layout: fixed`** again; expanded header panels are width-contained (`minmax(0, 1fr)` + overflow) so opening Response headers no longer breaks/widens the list columns above.
- URL cells wrap with `overflow-wrap`; host and content-type use ellipsis; date and short columns stay nowrap.
- Horizontal + vertical scroll on the network table wrapper when content overflows.
- Network requests **URL** column is plain text (not a link); full value still available via `title` on hover.
- Timing tab **Name** column uses a wider wrapping layout so long labels are fully visible.
- Deploy scripts accept optional **`APP_URL`** as either `http://` or `https://`; container health probe tries local HTTP then HTTPS (and optional `APP_URL`).
- VM deploy installs **nginx** as an HTTP front proxy by default (`deploy/nginx-url-checker.conf`); app binds to `127.0.0.1` via systemd `-H`; skip with `--no-nginx`.

### Documentation

- `README.md` — [Network requests panel](README.md#network-requests-panel), [Headers display (tabs)](README.md#headers-display-tabs), [Content tab](README.md#content-tab-network-rows-only), [Timing tab](README.md#timing-tab-network-rows-only) / [Resource timing](README.md#resource-timing) (phase fields, derived DNS/TCP/TTFB, waterfall + **Queueing / stalled** / white-space explanation) / [Navigation timing](README.md#navigation-timing), [Resource summary vs Network requests](README.md#resource-summary-vs-network-requests), [Export](README.md#export) (JSON keeps timing; CSV is metadata index), and [Deployment](README.md#deployment-vercel--netlify).
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — detailed VM vs container deploy scripts and operations; manual GitHub Actions SSH deploy; `APP_URL` / `VM_APP_URL`; nginx front proxy on VM (`NGINX_PORT`, `--no-nginx`, TLS via [`scripts/setup-https.sh`](scripts/setup-https.sh) or LB).
- `README.md` — [Screenshot timing](README.md#screenshot-timing) documents when the full-page PNG is captured in the Playwright flow.

---

## [0.1.0] — 2026-08-20

Initial application release: Next.js + Playwright URL inspection tool with DNS override, network logging, and in-memory results only (no file/DB persistence).

### Added

#### Core application
- Next.js App Router (TypeScript) web app with single-page UI and `POST /api/check` API.
- Playwright Chromium integration to load URLs in a real headless browser.
- Per-request browser lifecycle (launch → capture → close).
- In-memory result handling only (server request RAM + React `useState`; no disk or database storage).
- Project documentation in `README.md`.

#### Input
- URL form for HTTP/HTTPS targets.
- Dynamic custom HTTP header editor (add/remove name–value pairs).
- Optional **Force DNS resolution** (hostname + IP) on the form.

#### Fetch / Playwright behavior
- Navigation with `waitUntil: "load"` (avoids hangs on sites that never reach `networkidle`).
- Best-effort short `networkidle` settle afterward (timeout ignored).
- Capture of rendered HTML (`page.content()`), page title, final URL, and status.
- Full-page PNG screenshot (returned as base64).
- Main-document request and response headers via Playwright `allHeaders()`.
- DOM resource extraction: links, images, stylesheets, scripts, iframes, and other URLs.
- Network collector for all responses observed during the load (date, URL, remote host, status, content type, content size, resource type).
- Chromium `--host-resolver-rules=MAP <host> <ip>` for DNS override (applies to **all** same-host requests in that browser instance, not only the initial navigation).
- Skip Node DNS lookup when a valid DNS override is present.

#### UI
- Meta strip: status, final URL, timing, DNS override when applied.
- **HTTP headers** panel (request + response tables).
- **Resource summary** with collapsible per-category lists.
- **Full content** tabs:
  - Screenshot
  - HTML (sandboxed iframe preview)
  - Plain text (raw HTML source as text)
- **Network requests** table at the bottom of results.
- Loading and error alerts.

#### API (`POST /api/check`)
- Request body: `url`, optional `headers[]`, optional `dnsOverride: { host, ip }`.
- Response fields: `finalUrl`, `status`, `title`, `html`, `screenshotBase64`, `resources`, `requestHeaders`, `responseHeaders`, `networkRequests`, `dnsOverride`, `timingMs`, optional `error`.
- Node.js runtime with `maxDuration` 60s.
- `playwright` configured as `serverExternalPackages`.

#### Validation and security
- Allow only `http:` / `https:`.
- Reject URLs with embedded credentials.
- Block localhost / `.local` / `.internal` hostnames.
- Block private, loopback, link-local, CGNAT, and other reserved IPs (including after DNS resolution when no override).
- Block unsafe / hop-by-hop headers (e.g. `Host`, `Connection`, `Transfer-Encoding`).
- Header name/value length and count limits.
- DNS override: public IP only; host must match URL hostname; blocked hostnames rejected.
- HTML preview uses empty `sandbox` (scripts do not run in the UI).

#### Tooling / ops
- `postinstall`: `playwright install chromium`.
- npm scripts: `dev`, `build`, `start`, `lint`.
- HTML size cap (~2M chars) and network entry cap (~2000).
- Navigation timeout 45s; network-idle budget 5s.

### Fixed

- Timeout on sites that keep background network activity (e.g. docs with analytics): replaced hard `waitUntil: "networkidle"` with `load` + optional idle wait.

### Notes

- Results are **not** written to files or external stores.
- Third-party hosts are not remapped by DNS override (only the exact mapped hostname).
- One Chromium instance per check (no browser pool).
- No auth, history, or multi-user persistence in this version.
