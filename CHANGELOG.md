# Changelog

All notable changes to **URL Checker** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

### Added

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

### Changed

- Network table layout switched from cramped `table-layout: fixed` to **auto layout** with column `min-width` / `max-width` rules to stop columns overlapping.
- URL cells wrap with `overflow-wrap`; host and content-type use ellipsis; date and short columns stay nowrap.
- Horizontal + vertical scroll on the network table wrapper when content overflows.

### Documentation

- `README.md` — [Network requests panel](README.md#network-requests-panel) documents columns, expand/breakout width, **filters** (controls, AND logic, remount reset), and API entry shape.
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
