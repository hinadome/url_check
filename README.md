# URL Checker

A Next.js web application that loads any public URL in a real headless Chromium browser (Playwright), then shows what the browser fetched and rendered: HTTP headers, extracted page resources, full-page screenshot, HTML preview, HTML source as plain text, and a full network request log.

Optional **force DNS resolution** maps the URL hostname to a specific IP inside Chromium (bypassing system DNS for that host for the whole check).

---

## Table of contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture) (includes [Screenshot timing](#screenshot-timing))
4. [Force DNS resolution](#force-dns-resolution)
5. [How content is stored](#how-content-is-stored)
6. [User interface](#user-interface)
7. [Network requests panel](#network-requests-panel) (includes [Headers display](#headers-display-tabs), [Content tab](#content-tab-network-rows-only))
8. [Export](#export)
9. [Deployment (Vercel / Netlify)](#deployment-vercel--netlify) — prefer VM/container: [DEPLOYMENT.md](DEPLOYMENT.md)
10. [API reference](#api-reference)
11. [Project structure](#project-structure)
12. [Getting started](#getting-started)
13. [Configuration and limits](#configuration-and-limits)
14. [Security](#security)
15. [Limitations and out of scope](#limitations-and-out-of-scope)
16. [Tech stack](#tech-stack)
17. [Changelog](#changelog)

---

## Overview

URL Checker is a single-page tool plus one server API:

1. The user submits a URL, optional custom HTTP headers, and an optional DNS override (hostname → IP).
2. The server validates input (including SSRF guards), then launches Playwright Chromium.
3. If a DNS override is set, Chromium is started with `--host-resolver-rules=MAP <host> <ip>`.
4. The browser navigates to the URL (`waitUntil: "load"`, plus a short best-effort `networkidle` wait).
5. The server collects HTML, a full-page screenshot, main-document headers, DOM resource URLs, and every network response observed during the load.
6. The UI displays those results. Nothing is persisted to disk or a database.

Typical uses:

- Inspect how a page looks when rendered by a real browser (not just `curl`).
- See which hosts, assets, and response headers a page pulls in.
- Debug custom headers (for example `User-Agent` or `Authorization`) against a live site.
- Hit a specific origin IP while keeping the public hostname in the URL (pre-cutover, alternate edge, etc.).

---

## Features

| Area | What you get |
|------|----------------|
| URL input | HTTP/HTTPS URL to check |
| Custom headers | Add/remove name–value pairs sent with the Playwright request context |
| Force DNS | Optional hostname → IP map via Chromium `--host-resolver-rules` |
| Status / meta | Final URL, HTTP status, timing, applied DNS override |
| HTTP headers | Main-document request/response headers via **Request** / **Response** tabs |
| Resource summary | Links, images, stylesheets, scripts, iframes, other URLs from the live DOM |
| Full content | Screenshot, sandboxed HTML preview, plain-text HTML source |
| Network log | Date-stamped, filterable table; expandable rows with Request/Response/Content tabs |
| Export | Client-side downloads: JSON (light/full), PNG, HTML, network CSV index |

---

## Architecture

```text
Browser UI (React)
    │  POST /api/check  { url, headers?, dnsOverride? }
    ▼
Next.js API route (Node.js)
    │  validate URL + headers + DNS override (SSRF guards)
    ▼
Playwright Chromium
    │  optional: --host-resolver-rules=MAP host ip
    │  goto → capture HTML, screenshot, headers, DOM resources, network
    ▼
JSON response → React state → UI panels
```

### Request lifecycle

1. **Client** — `app/page.tsx` posts JSON to `/api/check`.
2. **Validation** — `lib/validate.ts`:
   - Allows only `http`/`https`, blocks private/localhost targets, filters unsafe headers.
   - Validates optional `dnsOverride` (public IP; host must match URL hostname).
   - When a valid override is present, **skips Node DNS lookup** for the URL host (traffic will use the forced IP in Chromium).
3. **Fetch** — `lib/playwright-fetch.ts` launches Chromium per request (with host-resolver args when overriding), applies `extraHTTPHeaders`, navigates with `waitUntil: "load"`, then optionally waits up to a few seconds for `networkidle` (timeout ignored so busy sites still succeed).
4. **Capture** (in this order, after navigation + settle):
   1. Main document headers via Playwright `allHeaders()`
   2. `finalUrl`, `title`, then HTML via `page.content()`
   3. **Screenshot** via `page.screenshot({ fullPage: true, type: "png" })`
   4. DOM resource extraction (`lib/extract-resources.ts`)
   5. Flush network log (`lib/network-collector.ts`; responses were collected throughout the load via a `response` listener)
5. **Respond** — JSON returned to the client (includes `dnsOverride` used, or `null`); browser and in-memory server objects are discarded when the handler finishes.
6. **Render** — Client stores the payload in React state and renders panels.

### Screenshot timing

The full-page screenshot is **not** taken at navigation start. It runs in `lib/playwright-fetch.ts` only after:

1. `page.goto(url, { waitUntil: "load" })` completes (window `load`, timeout 45s), and
2. A best-effort `waitForLoadState("networkidle")` finishes or times out (budget 5s; failure is ignored), and
3. Main-document headers, title, and HTML have already been read.

So the PNG reflects the page **after load (+ optional idle settle)**, at roughly the same DOM state as the captured HTML. Resource extraction runs **after** the screenshot. There is no separate screenshot timestamp in the API—only overall `timingMs` for the whole check.

Chromium is installed automatically on `npm install` via the `postinstall` script (`playwright install chromium`). Playwright is marked as a server external package in `next.config.ts`.

---

## Force DNS resolution

### Purpose

Force Chromium to connect to a **specific IP** for the URL’s hostname instead of using the machine’s default DNS answer. The browser still uses the real hostname in the URL, TLS SNI, and `Host` header.

### How it is implemented

| Layer | Behavior |
|-------|----------|
| UI | `UrlForm` optional fields: hostname + IP (`components/UrlForm.tsx`) |
| API | `dnsOverride: { host, ip }` on `POST /api/check` |
| Validation | `validateDnsOverride()` in `lib/validate.ts` |
| Browser | `chromium.launch({ args: ['--host-resolver-rules=MAP host ip'] })` in `lib/playwright-fetch.ts` |

Chromium’s `MappedHostResolver` applies `--host-resolver-rules` to the **browser-process host resolver**. That means the mapping is **not limited to the first navigation**.

### Scope: which requests use the forced IP?

| Request | Uses forced IP? |
|---------|-----------------|
| Initial document navigation to the mapped host | Yes |
| Later same-host requests (fetch/XHR, scripts, CSS, images, etc.) | Yes |
| Requests to **other** hostnames (CDNs, third parties) | No — normal DNS |
| Subdomains not listed in the MAP rule (e.g. `www.` vs apex) | No — only the exact mapped host |

We map **exactly** the URL hostname (or the host you enter, which must equal the URL hostname). Wildcards like `*.example.com` are not supported in the UI/API today.

### UI usage

1. Enter the URL (e.g. `https://example.com/path`).
2. Under **Force DNS resolution (optional)**:
   - **Hostname** — leave blank to use the URL hostname, or enter the same hostname explicitly.
   - **IP address** — public IPv4/IPv6 to dial (e.g. `203.0.113.10`).
3. Submit. Meta shows `DNS override: host → ip` when applied.

### API example

```bash
curl -s -X POST http://localhost:3000/api/check \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "dnsOverride": { "host": "example.com", "ip": "203.0.113.10" }
  }'
```

### Validation rules

- `ip` is required if override is set; must be a valid IP.
- Target IP must **not** be private, loopback, link-local, CGNAT, or other reserved ranges (SSRF).
- `host` defaults to the URL hostname when omitted; if provided, it **must match** the URL hostname.
- Blocked hostnames (`localhost`, `*.local`, `*.internal`, etc.) are rejected.
- With a valid override, server-side Node `dns.lookup` for the URL host is skipped; Chromium dials the forced IP instead.

### TLS note

Because the hostname in the URL is unchanged, certificates are validated for that hostname as usual. If the forced IP does not present a valid cert for that name, navigation fails (e.g. `net::ERR_CERT_COMMON_NAME_INVALID`). That is expected when pointing a name at the wrong host.

### Code map

```text
components/UrlForm.tsx      → collect dnsHost / dnsIp
app/api/check/route.ts      → validateDnsOverride + validateUrl({ skipDnsLookup })
lib/validate.ts             → validateDnsOverride(), validateUrl()
lib/playwright-fetch.ts     → --host-resolver-rules=MAP …
lib/types.ts                → DnsOverride on CheckRequest / CheckResponse
```

---

## How content is stored

| Storage type | Used? | Details |
|--------------|-------|---------|
| **Files on disk** | No | The app does not write HTML, screenshots, or logs to the filesystem. |
| **Memory** | Yes | Server holds results only for the duration of the API request. The browser holds the latest result in React `useState` until refresh, another check, or tab close. |
| **Other (DB, Redis, localStorage, etc.)** | No | There is no persistence, history, or shared cache. |

Implications:

- Refreshing the page clears results.
- Concurrent checks do not share stored content.
- Large pages (big HTML + base64 screenshot + network body sizes) increase peak RAM usage for that request and for the browser tab.

---

## User interface

Layout (top to bottom after a successful check):

1. **Form** — URL, optional force DNS (host + IP), custom header editor, submit.
2. **Meta** — status, final URL, timing, DNS override (when used), and **Export** menu.
3. **HTTP headers** — main-document headers with **Request** / **Response** tabs (full-width table per tab).
4. **Resource summary** — collapsible lists of URLs found in the rendered DOM.
5. **Full content**
   - **Screenshot** — full-page PNG (`data:image/png;base64,...`), captured after `load` (+ optional `networkidle` settle) and after HTML is read (see [Screenshot timing](#screenshot-timing)).
   - **HTML** — sandboxed iframe (`sandbox=""`, `srcDoc`) so scripts do not run in the preview.
   - **Plain text** — raw HTML source shown as text in a `<pre>` block.
6. **Network requests** — expandable, filterable table; per-row Request / Response / Content tabs (see [Network requests panel](#network-requests-panel)).

Components live under `components/`:

- `ExportMenu.tsx` — result export dropdown
- `UrlForm.tsx` / `HeaderEditor.tsx` — input (including DNS override)
- `HeadersPanel.tsx` / `HeadersTabs.tsx` — main-document headers (Request / Response tabs)
- `ResourceSummary.tsx` — DOM resource lists
- `ContentPreview.tsx` — screenshot / HTML / plain text tabs
- `NetworkRequestsPanel.tsx` — network table (date, expand width, filters, per-row Request/Response/Content tabs)

---

## Network requests panel

The network log is built from Playwright `response` events during the check (`lib/network-collector.ts`) and rendered by `components/NetworkRequestsPanel.tsx`.

### Columns

| Column | Source | Notes |
|--------|--------|-------|
| **Date** | `date` (ISO-8601) | When the response was observed on the server; shown in local time; rows sorted chronologically |
| **URL** | `url` | Full request URL; wraps long paths; `title` attribute has the full value |
| **Remote host** | `host` | Host portion of the URL |
| **Status** | `status` | HTTP status code |
| **Content type** | `contentType` | MIME type (parameters after `;` hidden in the cell) |
| **Content size** | `contentSize` | From `Content-Length` when present, otherwise response body length when available |
| **Type** | `resourceType` | Playwright resource type (`document`, `script`, `stylesheet`, etc.) |

Expand a row (▸), then use **Request headers** / **Response headers** / **Content** tabs (default: **Response**).

### Headers display (tabs)

Shared UI: `components/HeadersTabs.tsx` (used by the main **HTTP headers** panel and each expanded network row).

| Behavior | Detail |
|----------|--------|
| Tabs | **Request headers** / **Response headers**; network rows also get **Content** |
| Default tab | Response |
| Layout | One full-width name/value table at a time (not side-by-side) |
| Name column | Fixed ~12rem (14rem when the network panel is width-expanded); ellipsis on long names so keys stay next to values |
| Value column | Remaining width; long values wrap |
| Network list stability | Parent network table uses `table-layout: fixed`; expanded panels are width-contained so opening tabs does **not** reflow/widen the list columns above |

### Content tab (network rows only)

Captured in `lib/network-collector.ts` from each Playwright response body and shown via the **Content** tab in `HeadersTabs`.

| `bodyEncoding` | UI behavior |
|----------------|-------------|
| `text` | Body shown as plain text (`<pre>`, same style as Full content → Plain text) |
| `base64` | Body shown as a base64 string; label notes “Binary content shown as base64” |
| `empty` | Tab is available but the panel shows **nothing** (no placeholder message) |

**Binary vs text (summary):**

- Treated as **text**: `text/*`, JSON, XML, JavaScript, SVG/XHTML, `application/x-www-form-urlencoded`, etc.
- Treated as **binary**: `image/*`, `audio/*`, `video/*`, `font/*`, `application/octet-stream`, PDF, zip/wasm/protobuf/office types, or any body sample containing a null byte.
- Unknown types default to text unless a null byte is found.

**Fields on each `networkRequests[]` entry:**

| Field | Meaning |
|-------|---------|
| `bodyEncoding` | `text` \| `base64` \| `empty` |
| `body` | UTF-8 text, base64 string, or `""` |
| `bodyTruncated` | `true` if the body exceeded the capture cap (~512KB) |

The main document **HTTP headers** panel does **not** include a Content tab.

### Width and layout

- The panel **breaks out** of the main 960px form column so the table has more horizontal room (up to about `90rem`, or nearly full viewport when expanded).
- **Expand width** / **Collapse width** toggles near-full-viewport width for long URL lists.
- Table uses **`table-layout: fixed`** with stable column widths so expanding a row does not reshape the list.
- The table wrapper scrolls vertically (and horizontally if needed) when content exceeds the panel.

### Filters

Filtering is **client-side only** (no extra API calls). Controls sit above the table in `NetworkRequestsPanel`. Dropdown options are built from the current result set (unique hosts, statuses, resource types, and shortened content types).

| Control | Behavior |
|---------|----------|
| **URL contains** | Case-insensitive substring match on the request URL |
| **Remote host** | Exact match; options = distinct `host` values in this check |
| **Status** | Exact HTTP status; options = distinct status codes in this check |
| **Type** | Exact Playwright `resourceType` (`document`, `script`, `stylesheet`, etc.) |
| **Content type** | Exact match on shortened MIME type (part before `;`) |
| **Clear filters** | Resets every control; disabled when nothing is active |

**Match count:** the subtitle shows `Showing N of M responses` and appends `(filtered)` when any filter is active.

**Empty state:** if filters exclude everything, the table is replaced with “No requests match the current filters.”

**Reset on new check:** `app/page.tsx` remounts the panel with `key={finalUrl-timingMs}`, so filter state starts clean for each successful check.

Filters combine with **AND** logic (a row must satisfy every active control).

### API field

Each `networkRequests[]` entry includes:

```json
{
  "url": "https://example.com/style.css",
  "host": "example.com",
  "status": 200,
  "contentType": "text/css",
  "contentSize": 4096,
  "resourceType": "stylesheet",
  "date": "2026-08-20T20:18:00.123Z",
  "requestHeaders": [{ "name": "accept", "value": "*/*" }],
  "responseHeaders": [{ "name": "content-type", "value": "text/css" }],
  "bodyEncoding": "text",
  "body": "body { margin: 0; }",
  "bodyTruncated": false
}
```

Collection is capped (see [Configuration and limits](#configuration-and-limits)).

---

## Export

After a successful check, use **Export** on the meta strip (`components/ExportMenu.tsx`). Downloads are built in the browser from the current result (`lib/export.ts`) — nothing is written on the server.

| Menu item | File | Contents |
|-----------|------|----------|
| **JSON (light)** — recommended | `.json` | Full result shape; `screenshotBase64` cleared; network `body` cleared (`bodyEncoding: "empty"`). **Keeps** main + per-request headers, resources, HTML, network metadata |
| **JSON (full)** | `.json` | Complete `CheckResponse` including screenshot base64 and network bodies |
| **Screenshot (PNG)** | `.png` | Decoded full-page screenshot (disabled if none) |
| **HTML source** | `.html` | Captured HTML |
| **Network CSV (index)** | `.csv` | Metadata rows only: `date`, `url`, `host`, `status`, `contentType`, `contentSize`, `resourceType`, `bodyEncoding`, `bodyTruncated`, `requestHeaderCount`, `responseHeaderCount` |

**Design rule:** CSV is a spreadsheet-friendly **index**. Request/response header maps and body content live in **JSON**, not CSV. HAR export is not in v1.

Filenames look like `url-checker-example.com-20260820-143005-light.json`.

---

## Deployment (Vercel / Netlify)

For **production Playwright checks**, use a **VM or container** instead — see **[DEPLOYMENT.md](DEPLOYMENT.md)** (`scripts/deploy-vm.sh`, `scripts/deploy-container.sh`). Manual GitHub Actions SSH deploy to a VM is documented there as well (`workflow_dispatch` only).

This app is **Next.js** (not TanStack/Nitro). Vercel/Netlify configs below are for optional UI hosting only.

| Platform | Config | Notes |
|----------|--------|--------|
| **Vercel** | [`vercel.json`](vercel.json) | `framework: nextjs`; `/api/check` function `maxDuration` 60s, memory 3008 MB |
| **Netlify** | [`netlify.toml`](netlify.toml) | `@netlify/plugin-nextjs`; function timeout 60s; Playwright paths included for bundling |

### Deploy commands

**Vercel**

```bash
npm ci
npm run build:vercel   # same as next build
npx vercel             # or connect the Git repo in the Vercel dashboard
```

**Netlify**

```bash
npm ci
npm run build:netlify  # same as next build
npx netlify deploy --build   # or connect the Git repo in the Netlify dashboard
```

Local production:

```bash
npm run build
npm start
```

`postinstall` runs `playwright install chromium` so browsers are present after `npm ci` when the environment allows downloads.

### Playwright on serverless (important)

`/api/check` launches **full Chromium** via Playwright. That works reliably on:

- Local `next dev` / `next start`
- A VPS or container with enough RAM/CPU and system deps for Chromium

On **Vercel / Netlify serverless**, Chromium often fails or is unsupported (binary size, missing OS libraries, cold start, memory). Expect:

- The **UI** to deploy and load
- **`POST /api/check`** to error unless the platform can run Playwright Chromium

Mitigations (not implemented in this repo yet): run the API on a long-lived Node host, use a remote browser service, or switch to a serverless-oriented browser build (e.g. `@sparticuz/chromium` + `playwright-core`) with platform-specific wiring.

Hobby plans may also enforce **shorter** function timeouts than 60s — upgrade or self-host if checks time out.

---

## API reference

### `POST /api/check`

**Runtime:** Node.js (`export const runtime = "nodejs"`).  
**Max duration:** 60 seconds (route `maxDuration`).

#### Request body

```json
{
  "url": "https://example.com",
  "headers": [
    { "name": "User-Agent", "value": "MyBot/1.0" }
  ],
  "dnsOverride": {
    "host": "example.com",
    "ip": "203.0.113.10"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Absolute `http` or `https` URL |
| `headers` | `{ name, value }[]` | No | Extra headers applied to the Playwright browser context |
| `dnsOverride` | `{ host, ip }` | No | Force Chromium to resolve `host` to `ip` (must match URL hostname; private IPs blocked) |

#### Success response

```json
{
  "finalUrl": "https://example.com/",
  "status": 200,
  "title": "Example Domain",
  "html": "<!DOCTYPE html>...",
  "screenshotBase64": "<base64 PNG>",
  "resources": {
    "links": [],
    "images": [],
    "stylesheets": [],
    "scripts": [],
    "iframes": [],
    "other": []
  },
  "requestHeaders": [{ "name": "user-agent", "value": "..." }],
  "responseHeaders": [{ "name": "content-type", "value": "text/html..." }],
      "networkRequests": [
        {
          "url": "https://example.com/",
          "host": "example.com",
          "status": 200,
          "contentType": "text/html; charset=UTF-8",
          "contentSize": 1256,
          "resourceType": "document",
          "date": "2026-08-20T20:18:00.123Z"
        }
      ],
  "dnsOverride": {
    "host": "example.com",
    "ip": "203.0.113.10"
  },
  "timingMs": 2100
}
```

| Field | Description |
|-------|-------------|
| `finalUrl` | URL after redirects |
| `status` | Main document HTTP status |
| `title` | Document title |
| `html` | Serialized DOM HTML (may be truncated; see limits) |
| `screenshotBase64` | Full-page PNG as base64 |
| `resources` | Deduplicated absolute URLs from the live DOM |
| `requestHeaders` / `responseHeaders` | Main navigation headers |
| `networkRequests` | Observed responses with date, URL, host, status, content type/size/type, per-entry headers, and `body` / `bodyEncoding` / `bodyTruncated` for the Content tab (capped; see limits) |
| `dnsOverride` | Applied force-resolve mapping, or `null` |
| `timingMs` | Server-side elapsed time for the check |
| `error` | Present on failure responses |

#### Error response

Validation or fetch failures return JSON with `error` set and empty/default fields. Typical HTTP status:

- `400` — invalid URL, blocked host, bad headers, invalid force-resolve, etc.
- `500` — unexpected Playwright/runtime failure

---

## Project structure

```text
url_checker/
├── app/
│   ├── api/check/route.ts    # POST /api/check
│   ├── globals.css           # UI styles
│   ├── layout.tsx
│   └── page.tsx              # Main UI + submit flow
├── components/
│   ├── ContentPreview.tsx
│   ├── ExportMenu.tsx
│   ├── HeaderEditor.tsx
│   ├── HeadersPanel.tsx
│   ├── HeadersTabs.tsx       # Shared Request/Response/Content tabs
│   ├── NetworkRequestsPanel.tsx
│   ├── ResourceSummary.tsx
│   └── UrlForm.tsx           # URL, DNS override, headers
├── lib/
│   ├── export.ts             # Client-side export builders (JSON/PNG/HTML/CSV)
│   ├── extract-resources.ts  # DOM URL extraction
│   ├── network-collector.ts  # Playwright response log
│   ├── playwright-fetch.ts   # Browser launch + capture (+ MAP args)
│   ├── types.ts              # Shared request/response types
│   └── validate.ts           # URL / header / DNS override guards
├── scripts/
│   ├── deploy-vm.sh          # VM install/build/systemd
│   └── deploy-container.sh   # Docker Compose build/up
├── deploy/
│   └── url-checker.service   # systemd unit template
├── Dockerfile
├── docker-compose.yml
├── DEPLOYMENT.md             # VM + container deploy guide
├── next.config.ts            # serverExternalPackages: playwright
├── vercel.json               # Vercel Next.js + /api/check limits
├── netlify.toml              # Netlify Next.js plugin + function timeout
├── package.json
├── CHANGELOG.md
└── README.md
```

---

## Getting started

### Prerequisites

- Node.js 20+ recommended
- npm
- Ability to download Chromium for Playwright (network access on first install)

### Install

```bash
npm install
```

This runs `postinstall` → `playwright install chromium`. If Chromium is missing later:

```bash
npx playwright install chromium
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Production

```bash
npm run build
npm start
```

### Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js development server |
| `npm run build` | Production build |
| `npm start` | Serve production build |
| `npm run lint` | ESLint |
| `postinstall` | Install Playwright Chromium |

---

## Configuration and limits

Defined mainly in `lib/playwright-fetch.ts` and related libs:

| Setting | Value | Purpose |
|---------|-------|---------|
| Navigation timeout | 45s | `page.goto` with `waitUntil: "load"` |
| Network idle budget | 5s | Best-effort settle; timeout ignored |
| Max HTML chars | 2,000,000 | Truncate oversized serialized HTML |
| Max network entries | 2,000 | Cap collected responses |
| Max network body bytes | 512,000 | Per-response body capture for Content tab (text or base64); truncated beyond this |
| Content size | Prefer `Content-Length`; else response body length when available | Shown in network table |
| DNS override | Chromium `--host-resolver-rules=MAP host ip` | Process-wide for that browser instance |
| API `maxDuration` | 60s | Next.js route limit |

Deploy note: the host must allow launching Chromium (sufficient RAM/CPU; often needs system libraries on Linux). **Vercel/Netlify serverless is a poor fit for Playwright** unless you add a serverless browser strategy — prefer `next start` on a Node server for production checks. See [Deployment](#deployment-vercel--netlify).

---

## Security

Built-in guards (v1):

- Only `http:` and `https:` schemes.
- URLs with embedded credentials are rejected.
- Localhost / `.local` / `.internal` hostnames blocked.
- Private, loopback, link-local, and other reserved IPs blocked (including after DNS resolution when no override is used).
- Dangerous hop-by-hop / override headers blocked (for example `Host`, `Connection`, `Transfer-Encoding`).
- Header name/value length and count limits.
- Optional DNS override must use a **public** IP and a host that **matches** the URL hostname; Node DNS lookup is skipped only when a valid override is present (prevents using MAP to reach RFC1918 addresses).
- HTML preview uses an empty `sandbox` attribute so scripts do not execute in the UI.

This is not a full multi-tenant hardening suite. Do not expose an open instance to the public internet without auth, rate limits, and further SSRF review.

---

## Limitations and out of scope

- No authentication, user accounts, or audit log.
- No persistent history (memory-only results).
- One Chromium browser per request (no shared pool).
- `networkidle` is not required for success (sites with perpetual analytics/websockets would otherwise hang).
- Screenshot + large HTML payloads can make JSON responses heavy.
- Sites that block headless browsers, require interactive CAPTCHAs, or depend on special client TLS may fail or look incomplete.
- DNS override maps a single exact hostname (no multi-host or wildcard UI yet).
- Third-party hosts are never remapped by the DNS override.
- Export is client-side only (no server archive store); Network CSV is a metadata index (no header/body cells); HAR not included in v1.
- No PDF export or editable HTML workspace.

---

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Playwright** (Chromium) for real-browser fetching
- **Tailwind CSS v4** (via `@import "tailwindcss"`) plus custom CSS in `app/globals.css`

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a versioned list of all implementations and changes.

---

## License

Private project (`"private": true` in `package.json`). Add a license file if you intend to distribute it.
