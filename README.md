# URL Checker

A Next.js web application that loads any public URL in a real headless Chromium browser (Playwright), then shows what the browser fetched and rendered: HTTP headers, extracted page resources, full-page screenshot, HTML preview, HTML source as plain text, and a full network request log.

Optional **force DNS resolution** maps the URL hostname to a specific IP inside Chromium (bypassing system DNS for that host for the whole check).

---

## Table of contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture) (includes [Screenshot timing](#screenshot-timing))
4. [Force DNS resolution](#force-dns-resolution) (includes [HTTP protocol controls](#http-protocol-controls))
5. [How content is stored](#how-content-is-stored) — backend vs browser; theme `localStorage`; ephemeral HAR temp
6. [User interface](#user-interface) (includes [Resource summary vs Network requests](#resource-summary-vs-network-requests), [Plain text and non-HTML responses](#plain-text-and-non-html-responses))
7. [Network requests panel](#network-requests-panel) (includes [Failed / incomplete requests](#failed--incomplete-requests), [Headers display](#headers-display-tabs), [Content tab](#content-tab-network-rows-only), [Timing tab](#timing-tab-network-rows-only) / [Resource timing](#resource-timing) / [Navigation timing](#navigation-timing))
8. [Export](#export) (includes [HAR capture](#har-capture-playwright-session-archive) / [Capture HAR hang on heavy sites](#capture-har-hang-on-heavy-sites-e-g-costco))
9. [Deployment (Vercel / Netlify)](#deployment-vercel--netlify) — prefer VM/container ([re-runnable `deploy-vm.sh`](#vm-deploy-recommended-for-playwright)); details: [DEPLOYMENT.md](DEPLOYMENT.md)
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

1. The user submits a URL, optional custom HTTP headers, an optional DNS override (hostname → IP), optional **HTTP protocol** controls, and optionally **Ignore certificate errors** / **Capture HAR** (with **JSON** or **Zip** format).
2. The server validates input (including SSRF guards), then launches Playwright Chromium.
3. If a DNS override is set, Chromium is started with `--host-resolver-rules=MAP <host> <ip>`.
4. The browser navigates to the URL (`waitUntil: "load"`, plus a short best-effort `networkidle` wait). When ignore-cert is on, the context uses `ignoreHTTPSErrors: true`.
5. The server collects HTML, a full-page screenshot, main-document headers, DOM resource URLs, and every network response observed during the load.
6. The UI displays those results. Check payloads are not written to a database or the app directory (see [How content is stored](#how-content-is-stored)).

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
| Ignore cert errors | Optional checkbox (default **off**); Playwright `ignoreHTTPSErrors` for self-signed / expired TLS |
| HTTP protocol | Optional (below Force DNS): **HTTP/1.1 only**, Disable HTTP/2, Disable HTTP/3 (QUIC) — Chromium launch args (see [HTTP protocol controls](#http-protocol-controls)) |
| Capture HAR | Optional (default **off**); format radios **JSON** (default, binaries as base64) → **Zip** (binaries as files); Playwright `recordHar` → downloadable `.har` / `.har.zip` (not stored on the server). Soft cap `MAX_HAR_BYTES` (~45 MB) |
| Status / meta | Final URL, HTTP status, timing, DNS override, TLS ignore / HTTP protocol / HAR download (or HAR size warning) when used |
| Theme | Light / dark mode toggle (persisted in `localStorage`; follows system preference on first visit; no blocking theme `<script>`) |
| HTTP headers | Main-document request/response headers via **Request** / **Response** tabs |
| Resource summary | Links, images, stylesheets, scripts, iframes, other URLs from the live DOM |
| Full content | Screenshot, sandboxed HTML preview, plain-text HTML source |
| Network log | Date-stamped, filterable table with Remote IP + HTTP version; expandable rows with Request / Response / Content / Timing tabs |
| Failed requests | Separate panel (when non-empty) for Playwright `requestfailed` / typical HAR `status: -1`; method + failure text; filters; CSV; cap `MAX_NETWORK_FAILED_ENTRIES` |
| Export | Client-side downloads: JSON (light/full), PNG, HTML, HAR (when captured), network CSV index |

---

## Architecture

```text
Browser UI (React)
    │  POST /api/check  { url, headers?, dnsOverride?, ignoreCertErrors?, disableHttp2?, disableHttp3?, http11Only?, captureHar?, harFormat? }
    ▼
Next.js API route (Node.js)
    │  validate URL + headers + DNS override (SSRF guards)
    ▼
Playwright Chromium
    │  optional: --host-resolver-rules=MAP host ip
    │  optional: --disable-http2 / --disable-quic
    │  optional: ignoreHTTPSErrors
    │  optional: headed UA / sec-ch-ua (Costco-class HTTP/2 mitigation)
    │  optional: recordHar — json (default, embed → `har`) or zip (attach → `harZipBase64`)
    │  goto → capture HTML, screenshot, headers, DOM resources, network
    ▼
JSON response → React state → UI panels (+ client HAR download)
```

### Request lifecycle

1. **Client** — `app/page.tsx` posts JSON to `/api/check`.
2. **Validation** — `lib/validate.ts`:
   - Allows only `http`/`https`, blocks private/localhost targets, filters unsafe headers.
   - Validates optional `dnsOverride` (public IP; host must match URL hostname).
   - When a valid override is present, **skips Node DNS lookup** for the URL host (traffic will use the forced IP in Chromium).
3. **Fetch** — `lib/playwright-fetch.ts` launches Chromium per request (with host-resolver args when overriding), applies headed-compatible identity (UA / `sec-ch-ua`) unless overridden by custom headers, applies `extraHTTPHeaders`, sets `ignoreHTTPSErrors` when requested, optionally enables Playwright `recordHar` (`harFormat` **json** default or **zip**), navigates with `waitUntil: "load"`, then optionally waits up to a few seconds for `networkidle` (timeout ignored so busy sites still succeed). May retry once with `--disable-http2` after `ERR_HTTP2_PROTOCOL_ERROR`.
4. **Capture** (in this order, after navigation + settle):
   1. Main document headers via Playwright `allHeaders()`
   2. `finalUrl`, `title`, then HTML via `page.content()`
   3. **Screenshot** via `page.screenshot({ fullPage: true, type: "png" })`
   4. DOM resource extraction (`lib/extract-resources.ts`)
   5. Flush network log (`lib/network-collector.ts`; when Capture HAR is on, body capture is skipped — see [Capture HAR hang](#capture-har-hang-on-heavy-sites-e-g-costco))
   6. Close browser context (flushes HAR when `captureHar` was set); read archive into `har` or `harZipBase64`, or set `harError` if over `MAX_HAR_BYTES`; delete the temp dir
5. **Respond** — JSON returned to the client (includes protocol/HAR fields such as `har` / `harZipBase64` / `harError` / `http2FallbackApplied`); nothing is persisted to app storage or a database.
6. **Render** — Client stores the payload in React state and renders panels; HAR download is client-side only when `har` or `harZipBase64` is present.

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

To proceed anyway (self-signed, expired, or name mismatch), check **Ignore certificate errors** in the UI or send `"ignoreCertErrors": true` on `POST /api/check`. That sets Playwright’s browser context `ignoreHTTPSErrors: true` (per-check default **off**). Server admins can hide/disable this with `ALLOW_IGNORE_CERT_ERRORS=0` (default **allow** when unset; see [DEPLOYMENT.md](DEPLOYMENT.md#feature-gates-env--default-allow)).

### HTTP protocol controls

Playwright has **no** `httpVersion` request parameter. To restrict negotiation, URL Checker passes **allowlisted** Chromium launch args only (clients cannot send arbitrary flags).

**Form placement:** below **Force DNS resolution**, above Custom headers. Per-check default **off**. UI order (top → bottom):

| UI control | Chromium arg | Notes |
|------------|--------------|-------|
| **HTTP/1.1 only** | `--disable-http2` + `--disable-quic` | Preset: sets both disables; unchecking either independent box clears the preset |
| **Disable HTTP/2** | `--disable-http2` | Does **not** disable HTTP/3 — flags are independent |
| **Disable HTTP/3 (QUIC)** | `--disable-quic` | There is no `--disable-http3`; HTTP/3 uses QUIC |

**Effective matrix**

| Selection | Typical negotiated versions |
|-----------|----------------------------|
| Both disables off | Auto (`http/1.1`, `h2`, and/or `h3` as ALPN allows) |
| Disable HTTP/2 only | No `h2`; may still use `h3` or `http/1.1` |
| Disable HTTP/3 only | No `h3`; may still use `h2` or `http/1.1` |
| Both / HTTP/1.1 only | Typically `http/1.1` |

Negotiated version per resource still appears in Network → **HTTP** (`response.httpVersion()`). Meta strip and result JSON echo `disableHttp2`, `disableHttp3`, `http11Only`, and `chromiumProtocolArgs` (e.g. `["--disable-http2","--disable-quic"]`).

Admins: `ALLOW_HTTP_PROTOCOL_CONTROLS=0` hides the UI and rejects API requests that enable these options (**400**). Default **allow** when unset. Plan: [`docs/HTTP_PROTOCOL_ARGS_IMPLEMENT_PLAN.md`](docs/HTTP_PROTOCOL_ARGS_IMPLEMENT_PLAN.md).

#### Headless / `ERR_HTTP2_PROTOCOL_ERROR` (e.g. Costco)

Headless Chromium advertises `HeadlessChrome` in the user agent and `sec-ch-ua`. Some CDNs/WAFs (Akamai and similar) abort the connection with `net::ERR_HTTP2_PROTOCOL_ERROR`. URL Checker mitigates this by default:

1. Sets a headed Chrome `userAgent` and `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` unless the request already includes those headers.
2. If navigation still fails with `ERR_HTTP2_PROTOCOL_ERROR` and **Disable HTTP/2** was not requested, retries once with `--disable-http2` and returns `http2FallbackApplied: true` (meta strip shows “auto after HTTP/2 error”).

This is not stealth/bot-bypass tooling; it only removes the explicit headless client-hint branding that triggers the protocol error on some hosts.

### Code map

```text
components/UrlForm.tsx      → collect dns / ignoreCert / HTTP protocol / captureHar / harFormat (json default)
app/api/check/route.ts      → validateDnsOverride + validateUrl({ skipDnsLookup }) + gates
lib/validate.ts             → validateDnsOverride(), validateUrl()
lib/playwright-fetch.ts     → host-resolver; protocol args; headed UA; recordHar json|zip; HAR hang-aware collector
lib/network-collector.ts    → body/flush timeouts; captureBodies: false when HAR on
lib/types.ts                → DnsOverride + protocol flags + captureHar / harFormat / har / harZipBase64 / harError
```

---

## How content is stored

**Verdict:** Almost everything is ephemeral. The only durable client store is the theme preference. The server does **not** keep check history in a database or under the app tree.

### Backend server

**Not stored (no DB / no app-disk archive)**  
No database, Redis, file history, or check log under the project directory.

**Ephemeral only (while a check runs, then discarded)**

| Data | Where | Lifetime |
|------|--------|----------|
| Request body (`url`, headers, DNS override, ignore-cert, capture HAR / format) | Process memory in `POST /api/check` | Until the response finishes |
| Playwright browser + page | Process memory | Closed after each check |
| Network log, HTML, headers, screenshot buffer, timing | Process memory → JSON response | Same |
| HAR temp files (`…/url-checker-har-*/session.har` or `.har.zip`) | OS temp via `mkdtemp(os.tmpdir())` in [`lib/playwright-fetch.ts`](lib/playwright-fetch.ts) | Created → sized/read into the JSON response → **explicitly deleted** by the app (see below) |
| Feature flags | Read from env at runtime (`ALLOW_*`) | Host config, not per-check data |

**HAR temp cleanup (explicit app action)**  
The app does **not** rely on OS tmp scrubbing alone. After the HAR file is handled (success, oversize skip, or read error), `cleanupHarDir()` runs `fs.promises.rm(harDir, { recursive: true, force: true })` on the whole `url-checker-har-*` directory. That runs in the HAR block’s `finally`, and again in the outer `finally` if the directory was not cleared yet (e.g. failure before the HAR read).  

**Caveat:** if the Node process is killed hard (`kill -9`, OOM killer) before those `finally` blocks run, leftover `/tmp/url-checker-har-*` dirs can remain until manual or OS cleanup. Normal success and handled-error paths always call delete.

**Host config (not check data)**  
Env / systemd / nginx / Let’s Encrypt certificates if you set them up — ops configuration, not URL-check results.

### Browser

**Persisted**

| Data | Where | Key / note |
|------|--------|------------|
| Theme (`light` / `dark`) | `localStorage` | `url-checker-theme` (`ThemeProvider`) |

**In memory only (lost on refresh or leaving the page)**

| Data | Where |
|------|--------|
| Form state (URL, headers, DNS, checkboxes, HAR format) | React `useState` in `UrlForm` |
| Latest check result (HTML, screenshot base64, network rows/bodies, HAR, errors) | React `useState` in `app/page.tsx` |
| UI chrome (open tabs, filters, export menu) | Component state |
| Feature flags from `GET /api/config` | Fetched into form state |

**Downloads (user’s machine, not app storage)**  
Export JSON / PNG / HTML / HAR / CSV — only if the user clicks **Export**; saved by the browser download dialog.

### Implications

- Refreshing the page clears check results (theme preference remains).
- Concurrent checks do not share stored content on the server.
- Large pages (HTML + base64 screenshot + network bodies + optional HAR) increase peak RAM for that request and for the browser tab.
- Capture HAR uses a short-lived OS temp directory that the app **explicitly removes** after read (`cleanupHarDir` in `lib/playwright-fetch.ts`); nothing is kept under the app tree for archives.
---

## User interface

Layout (top to bottom after a successful check):

1. **Header** — product title and **Light / Dark** theme toggle (persisted).
2. **Form** — URL, optional force DNS (host + IP), optional **HTTP protocol** controls, custom header editor, then **Ignore certificate errors** and **Capture HAR** (default off; when on, **JSON** default or **Zip** format), submit.
3. **Meta** — status, final URL, timing, DNS override / TLS ignore / HTTP protocol restrictions / HAR download link (or HAR unavailable) when used, and **Export** menu. Oversized HAR shows a warning alert; page results still render.
4. **HTTP headers** — main-document headers with **Request** / **Response** tabs (full-width table per tab).
5. **Resource summary** — collapsible lists of URLs found in the rendered DOM.
6. **Full content**
   - **Screenshot** — full-page PNG (`data:image/png;base64,...`), captured after `load` (+ optional `networkidle` settle) and after HTML is read (see [Screenshot timing](#screenshot-timing)).
   - **HTML** — sandboxed iframe (`sandbox=""`, `srcDoc`) so scripts do not run in the preview.
   - **Plain text** — serialized document from `page.content()` shown as text in a `<pre>` block (see [Plain text and non-HTML responses](#plain-text-and-non-html-responses)).
7. **Network requests** — expandable, filterable table; per-row Request / Response / Content tabs (see [Network requests panel](#network-requests-panel)).
8. **Failed / incomplete requests** — shown only when Playwright `requestfailed` events occurred (see [Failed / incomplete requests](#failed--incomplete-requests)).

### Plain text and non-HTML responses

**Plain text** under Full content does **not** invent HTML. It prints whatever Playwright captured with `page.content()` (`lib/playwright-fetch.ts`), unchanged, inside a `<pre>` (`components/ContentPreview.tsx`).

When the checked URL returns **JSON** (or some other non-HTML body), Chromium often builds a small **viewer document** around the payload instead of leaving a bare JSON string as the page source. That wrapper commonly looks like:

```html
<html>
  <head>
    <meta name="color-scheme" content="light dark">
    <meta charset="utf-8">
  </head>
  <body>
    <pre>…actual JSON or text…</pre>
  </body>
</html>
```

So in Plain text you may see outer `<html>`, `color-scheme`, and `<pre>` tags **plus** your JSON inside `<pre>`. That shell is from **Chromium’s display of the resource**, not from the Plain text tab adding markup.

| View | What you get |
|------|----------------|
| Full content → **Plain text** / **HTML** | Browser document DOM (`page.content()`), including any Chromium JSON/text viewer wrapper |
| Network row → **Content** | HTTP response **body** from the network collector (closer to raw JSON bytes for that response) |

For the true response payload of a JSON API call, prefer the matching **Network requests** row → **Content** tab (or JSON export of that entry’s `body`).

### Resource summary vs Network requests

The **unique URLs** count on Resource summary and the **responses** count on Network requests measure different things and often will not match.

| | **Resource summary** | **Network requests** |
|--|----------------------|----------------------|
| Source | Final DOM after load (`lib/extract-resources.ts`) | Playwright `response` events during the check (`lib/network-collector.ts`) |
| What is counted | URLs from attributes such as `a[href]`, `img[src]` / `srcset`, stylesheets, scripts, iframes, and a few other tags | One row per HTTP **response** the browser received |
| Deduping | Unique **per category** (the same URL in links and images counts twice toward the total) | Not unique by URL — the same URL can appear more than once |
| Skips | `data:` and `javascript:` URLs | N/A (only actual network responses) |
| Typically includes | Link targets that were never fetched | Document, XHR/fetch, fonts, redirects, beacons, third-party calls, etc. |
| Typically excludes | XHR/fetch, CSS-only fonts, redirects, WebSockets, analytics that never appear as DOM attributes | Plain `<a href>` links that were never requested |
| Cap | None beyond what is in the DOM | Soft cap of ~2,000 entries |

**Why one side can be higher:**

- **Resource summary higher** — many unclicked `<a href>` (and similar) URLs in the DOM that the browser never requested.
- **Network higher** — JS/API traffic, redirects, duplicate fetches, fonts loaded only via CSS, third-party calls, and other responses that never show up as extractable DOM attributes.

Components live under `components/`:

- `ThemeToggle.tsx` / `ThemeProvider.tsx` — light/dark mode (header toggle; `data-theme` on `<html>`)
- `ExportMenu.tsx` — result export dropdown (includes HAR when captured)
- `UrlForm.tsx` / `HeaderEditor.tsx` — input (DNS override, custom headers, ignore cert errors, capture HAR)
- `HeadersPanel.tsx` / `HeadersTabs.tsx` — main-document headers (Request / Response); network rows also Content / Timing
- `ResourceSummary.tsx` — DOM resource lists
- `ContentPreview.tsx` — screenshot / HTML / plain text tabs
- `NetworkRequestsPanel.tsx` — network table (date, remote IP, HTTP version, expand width, filters, per-row Request/Response/Content/Timing tabs)
- `NetworkFailedRequestsPanel.tsx` — failed / aborted requests (`requestfailed`); hidden when empty

---

## Network requests panel

The network log is built from Playwright `response` events during the check (`lib/network-collector.ts`) and rendered by `components/NetworkRequestsPanel.tsx`.

HTTP **4xx/5xx** still appear here (they emit `response`). Requests with **no HTTP response** (HAR often `status: -1`) are listed separately under [Failed / incomplete requests](#failed--incomplete-requests).

### Columns

| Column | Source | Notes |
|--------|--------|-------|
| **Date** | `date` (ISO-8601) | When the response was observed on the server; shown in local time; rows sorted chronologically |
| **Method** | `method` | HTTP method from Playwright `request.method()` (`GET`, `POST`, …) |
| **URL** | `url` | Full request URL (plain text, not a link); wraps long paths; `title` has the full value |
| **Remote host** | `host` | Host portion of the URL |
| **Remote IP** | `remoteIp` | From Playwright `response.serverAddr()`; `—` if unavailable (`remotePort` is kept in JSON/`title`) |
| **Status** | `status` | HTTP status code |
| **HTTP** | `httpVersion` | From `response.httpVersion()` (e.g. `http/1.1`, `h2`) |
| **Content type** | `contentType` | MIME type (parameters after `;` hidden in the cell) |
| **Content size** | `contentSize` | From `Content-Length` when present, otherwise response body length when available |
| **Type** | `resourceType` | Playwright resource type (`document`, `script`, `stylesheet`, etc.) |

Expand a row (▸), then use **Request headers** / **Response headers** / **Content** / **Timing** tabs (default: **Response**).

### Headers display (tabs)

Shared UI: `components/HeadersTabs.tsx` (used by the main **HTTP headers** panel and each expanded network row).

| Behavior | Detail |
|----------|--------|
| Tabs | **Request headers** / **Response headers**; network rows also get **Content** and **Timing** |
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

**When Capture HAR is on:** network rows use `bodyEncoding: "empty"` (no per-response `body()`). Use the downloaded HAR for response bodies. See [Capture HAR hang on heavy sites](#capture-har-hang-on-heavy-sites-e-g-costco).

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

### Timing tab (network rows only)

Expand a network row → **Timing**.

| Section | Source | When shown |
|---------|--------|------------|
| **Resource timing** | Playwright `request.timing()` (`timing` on each entry) | Every network row (see [Resource timing](#resource-timing)); includes a **waterfall** graph |
| **Navigation timing** | Page `performance.getEntriesByType('navigation')` → `navigationTiming` on the check result | Only on rows with `resourceType === "document"`; includes a **waterfall** when present |

Timing details stay in **JSON** export; Network CSV includes `remoteIp` / `remotePort` / `httpVersion` but not full timing maps.

#### Resource timing

Each network entry’s `timing` object comes from Playwright’s [`request.timing()`](https://playwright.dev/docs/api/class-request#request-timing), which mirrors the browser [Resource Timing API](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming) phases for that request.

**How to read the numbers**

| Rule | Detail |
|------|--------|
| Units | Milliseconds |
| `startTime` | Absolute timestamp (ms since Unix epoch) when the request started |
| Other phase fields | Offsets **relative to `startTime`** (not wall-clock times) |
| Unavailable | Playwright uses `-1`; the UI shows **—** |
| When filled | Most phases appear once a response starts; `responseEnd` is most accurate after the request finishes (`requestfinished`) |

**Phase fields (API + Timing tab)**

| Field | Meaning |
|-------|---------|
| `startTime` | Request start (epoch ms) |
| `domainLookupStart` | Just before DNS lookup begins |
| `domainLookupEnd` | Just after DNS lookup finishes |
| `connectStart` | Just before TCP connect starts |
| `secureConnectionStart` | Just before TLS handshake starts (`-1` / — on plain HTTP or when reused) |
| `connectEnd` | Just after the connection (and TLS, if any) is ready |
| `requestStart` | Just before the first byte of the request is sent |
| `responseStart` | Just after the first response byte is received (TTFB marker) |
| `responseEnd` | Just after the last response byte is received (or connection closes) |

**Derived rows in the UI** (computed for display; not separate API fields)

| Label | Calculation | What it approximates |
|-------|-------------|----------------------|
| DNS (lookup) | `domainLookupEnd − domainLookupStart` | Name resolution time |
| TCP connect | `connectEnd − connectStart` | Connect (+ TLS when folded into connect) |
| TTFB (responseStart − requestStart) | `responseStart − requestStart` | Time to first byte after the request is sent |
| Total (responseEnd − startTime) | Shown as `responseEnd` when ≥ 0 | End-to-end duration of this resource relative to request start (Playwright already stores `responseEnd` as an offset from `startTime`) |

**Typical waterfall (conceptual)**

```text
startTime
  ├─ domainLookupStart → domainLookupEnd     (DNS)
  ├─ connectStart → [secureConnectionStart] → connectEnd   (TCP / TLS)
  ├─ requestStart
  ├─ responseStart                           (first byte / TTFB)
  └─ responseEnd                             (body complete)
```

**Waterfall graph (Timing tab)**

Above the Resource timing table, the UI draws a DevTools-style waterfall (`components/TimingWaterfall.tsx`):

- **Stacked bar** — all phases on one timeline (0 → `responseEnd` or the latest phase end)
- **Per-phase rows** — DNS, Connect, TLS (when present), Waiting (TTFB), Content download, plus **Queueing / stalled** for gaps
- Phases with `-1` / missing ranges are omitted
- Zero-length phases render as a thin marker

Document rows also get a **Navigation waterfall** (DNS → load event) above the Navigation timing table.

**Why the waterfall used to show “white space” (and what we draw now)**

The scale is always **0 → `responseEnd`**. Colored segments are only the classified phases (DNS, Connect/TLS, Waiting, Download). Time that is **not** covered by those ranges is real timeline, not a CSS bug:

| Cause | What you see |
|-------|----------------|
| **Queueing / stall gaps** | Common gap between `connectEnd` and `requestStart` (browser queueing / stalled). Chrome DevTools labels this similarly. |
| **Missing early phases (`-1`)** | On connection reuse, DNS and Connect are often omitted; the first bar may start at `requestStart` ≫ 0, leaving empty time on the left. |
| **Scale starts at 0** | Mapping always begins at 0, not at the first known phase, so early uncovered time stays on the left of the track. |

The UI now fills those uncovered intervals with a hatched **Queueing / stalled** segment (before the first phase, between phases, and after the last phase up to the scale end), so the stacked bar looks continuous while still calling out unclassified time.

**Why some values are —**

- Connection or DNS was **reused** from an earlier request (Chrome often reports `-1` for lookup/connect).
- Request served from **cache** or a **service worker**.
- Timing not available yet, or the response never completed cleanly.
- Plain **HTTP** (no TLS) → `secureConnectionStart` is unavailable.

Resource timing is **per network request**. It is not the same as page-level Navigation Timing (DOMContentLoaded / `load`), which appears only on the main **document** row.

#### Navigation timing

Captured once per check via `performance.getEntriesByType("navigation")[0]` after load settle (`lib/playwright-fetch.ts` → `navigationTiming`). Shown only when you expand a **document** row’s Timing tab.

| Field | Meaning |
|-------|---------|
| `type` | Navigation type (e.g. `navigate`, `reload`) |
| `redirectCount` | Number of redirects for this navigation |
| `fetchStart` … `responseEnd` | Network phases for the main document (ms from the page time origin) |
| `domInteractive` | DOM ready for interaction |
| `domContentLoadedEventStart` / `End` | `DOMContentLoaded` event |
| `domComplete` | Document load complete |
| `loadEventStart` / `End` | Window `load` event |

Unlike Resource Timing’s `startTime` (Unix epoch ms), Navigation Timing values are relative to the **page performance time origin**.

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

### Failed / incomplete requests

Panel: `components/NetworkFailedRequestsPanel.tsx`  
API field: `networkFailedRequests`  
Collector: Playwright **`page.on("requestfailed")`** in [`lib/network-collector.ts`](lib/network-collector.ts)

These are requests that **never received an HTTP response** (browser/network layer failure). They often appear in Capture HAR with `response.status: -1`. They are **not** merged into the main Network requests table.

#### Included (shown in this panel)

| Included | Source / notes |
|----------|----------------|
| Playwright `requestfailed` events | DNS failure, TLS errors, connection refused/reset, aborted requests, many `net::ERR_*` cases |
| Method, URL, host, resource type | From the failed `Request` |
| Status | Always recorded as **`-1`** (no HTTP status) |
| Failure text | `request.failure()?.errorText` (e.g. `net::ERR_NAME_NOT_RESOLVED`) |
| Request headers | From `request.headers()` at failure time |
| Date | ISO timestamp when the failure was observed |

#### Excluded (not in this panel)

| Excluded | Where it goes instead / why |
|----------|------------------------------|
| HTTP **4xx / 5xx** (and any other status with a response) | **Network requests** — Playwright still emits `response` |
| Successful responses (2xx / 3xx, etc.) | **Network requests** |
| Incomplete-at-flush | **Not collected** — request started but neither `response` nor `requestfailed` before the check ended (e.g. still in flight when flush/context close runs). May still appear in HAR as `status: -1`. Deferred; see plan below |
| Failures after collector flush starts | Dropped for UI/API (`accepting = false`); HAR may still record them until context close |
| Failures beyond the cap | Dropped once `MAX_NETWORK_FAILED_ENTRIES` is reached (see Cap) |
| Collector internal errors | Silently skipped (same pattern as response collection) |
| Reconstructing failures from a downloaded HAR | Not done — only live `requestfailed` during the check |

So: **HAR can list more `status: -1` URLs than this panel.** The UI is a `requestfailed` subset, not a 1:1 HAR diff.

#### UI

| Item | Detail |
|------|--------|
| When shown | Only if `networkFailedRequests.length > 0` (**hidden when empty**) |
| Placement | Directly **below** Network requests |
| Columns | Date, Method, URL, Host, Type, Status (`-1`), Failure |
| Expand | Failure message + request headers (no Response / Content / Timing tabs) |
| Filters | URL contains, remote host, type, failure contains (AND); Clear filters; remounts per check |
| Width | Same expand/collapse width control pattern as Network requests |

#### Cap (`MAX_NETWORK_FAILED_ENTRIES`)

| Item | Detail |
|------|--------|
| **Default** | **500** failed rows per check |
| **Env** | `MAX_NETWORK_FAILED_ENTRIES` on the Node process (`.env`, systemd, Compose) — then **restart** |
| **Parsing** | Invalid / empty / non-positive → default 500; values clamped to **1…10000** |
| **Code** | `maxNetworkFailedEntries()` in [`lib/network-collector.ts`](lib/network-collector.ts) |
| **Behavior when full** | Further `requestfailed` events are ignored for the UI/API (check still succeeds) |
| **Related** | Successful responses are capped separately at **2000** (`MAX_NETWORK_ENTRIES`, code constant) |

Example:

```bash
# .env or systemd Environment=
MAX_NETWORK_FAILED_ENTRIES=1000
```

#### Export / API shape

| Channel | Behavior |
|---------|----------|
| JSON light / full | Includes `networkFailedRequests` (no bodies to strip) |
| **Export → Download failed network CSV** | Enabled when there is at least one failed row; columns: `date`, `method`, `url`, `host`, `status`, `resourceType`, `failureText`, `requestHeaderCount` |
| Network CSV (index) | Responses only — does **not** include failed rows |

Example entry:

```json
{
  "url": "https://blocked.example/pixel.gif",
  "host": "blocked.example",
  "method": "GET",
  "status": -1,
  "resourceType": "image",
  "date": "2026-08-25T15:00:00.123Z",
  "failureText": "net::ERR_NAME_NOT_RESOLVED",
  "requestHeaders": [{ "name": "user-agent", "value": "..." }]
}
```

Plan / deferred incomplete-at-flush: [`docs/FAILED_NETWORK_REQUESTS_UI_PLAN.md`](docs/FAILED_NETWORK_REQUESTS_UI_PLAN.md).

### API field (Network responses)

Each `networkRequests[]` entry includes:

```json
{
  "url": "https://example.com/style.css",
  "host": "example.com",
  "method": "GET",
  "status": 200,
  "contentType": "text/css",
  "contentSize": 4096,
  "resourceType": "stylesheet",
  "date": "2026-08-20T20:18:00.123Z",
  "remoteIp": "93.184.216.34",
  "remotePort": 443,
  "httpVersion": "h2",
  "timing": {
    "startTime": 12.0,
    "domainLookupStart": -1,
    "domainLookupEnd": -1,
    "connectStart": -1,
    "secureConnectionStart": -1,
    "connectEnd": -1,
    "requestStart": 0.5,
    "responseStart": 8.0,
    "responseEnd": 15.0
  },
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
| **JSON (light)** — recommended | `.json` | Full result shape; `screenshotBase64` cleared; `harZipBase64` cleared; network `body` cleared (`bodyEncoding: "empty"`). **Keeps** headers, resources, HTML, network metadata including `remoteIp` / `httpVersion` / `timing`, top-level `navigationTiming`, and `harError` if set |
| **JSON (full)** | `.json` | Complete `CheckResponse`: screenshot base64, network bodies, `har` / `harZipBase64` when present, **and** all timing fields |
| **Screenshot (PNG)** | `.png` | Decoded full-page screenshot (disabled if none) |
| **HTML source** | `.html` | Captured HTML |
| **HAR JSON** | `.har` | When `harFormat: "json"` — binaries base64-inlined |
| **HAR zip** | `.har.zip` | When `harFormat: "zip"` — binaries as zip files |
| **Network CSV (index)** | `.csv` | Metadata rows for **responses** only (`networkRequests`) |
| **Failed network CSV** | `-network-failed.csv` | `requestfailed` rows when any exist; disabled in the menu when empty |

**Design rule:** CSV is a spreadsheet-friendly **index**. Request/response header maps, body content, and full timing maps live in **JSON** or **HAR** (`.har` / `.har.zip`), not CSV.

Filenames look like `url-checker-example.com-20260820-143005-light.json` or `….har` / `….har.zip`.

### HAR capture (Playwright session archive)

Optional **Capture HAR** checkbox on the form (under **Custom headers**; per-check default **off**). Admins can disable with `ALLOW_CAPTURE_HAR=0` (see [DEPLOYMENT.md](DEPLOYMENT.md#feature-gates-env--default-allow)).

When Capture HAR is on, choose a format (UI order; **JSON** is default):

| `harFormat` | Playwright | Download | Binaries |
|-------------|------------|----------|----------|
| **`json`** (default) | `content: "embed"` → `session.har` | `.har` via `har` | Base64-inlined in HAR JSON |
| **`zip`** | `content: "attach"` → `session.har.zip` | `.har.zip` via `harZipBase64` | Raw files inside the zip |

1. Record into an **OS temp** directory created with `mkdtemp` under `os.tmpdir()` (prefix `url-checker-har-`; not under the app tree).
2. Close the browser context (flushes Playwright’s HAR recorder), then `stat` / `readFile` the archive into `har` or `harZipBase64` (or set `harError` if oversize/unreadable).
3. **Explicitly delete** that temp directory via `cleanupHarDir()` → `fs.promises.rm(…, { recursive: true, force: true })` in a `finally` block (also in the outer `finally` as a safety net). Soft oversize still deletes the temp files; page results still render.
4. Download from meta / **Export** (client-side only).

Offline: convert between zip and embed with [`scripts/convert-har.mjs`](scripts/convert-har.mjs) — see [`CONVERT_HAR.md`](CONVERT_HAR.md).

Hard process kills may leave orphaned `url-checker-har-*` dirs under OS temp; see [How content is stored](#how-content-is-stored).

#### Capture HAR hang on heavy sites (e.g. Costco)

**Symptom**

With **Capture HAR** checked, a check against a busy site such as `https://www.costco.com/` could sit on “Fetching page with Playwright…” and **never finish**, even after the page had clearly loaded. Without Capture HAR, the same URL often completed.

**What was wrong**

HAR recording itself was not the main blocker. Playwright’s HAR flush (`context.close()` → zip on disk) for Costco typically finishes in well under a second once capture stops.

The hang was in the **Network requests collector** (`lib/network-collector.ts`):

1. On every `response` event, the collector called Playwright `response.body()` to fill the Network **Content** tab (up to ~512KB per response, max 2000 entries).
2. At the end of the check, `network.flush()` ran `Promise.all(pending)` and waited for **every** in-flight body read.
3. Costco (and similar Akamai-backed retail sites) keeps **hundreds** of requests alive—ads, analytics, beacons, long-lived streams. Some of those `response.body()` calls **never resolve**.
4. With Capture HAR on, more resources are observed and body reads compete with HAR’s own body buffering, so the stall was much more likely. The UI waited forever on flush even though navigation, screenshot, and HAR write were already done (or nearly done).

So the process looked stuck on “HAR”, but it was stuck on **network body flush**, not on writing `session.har` / `session.har.zip`.

**How it was fixed**

| Change | Detail | Where |
|--------|--------|--------|
| Skip bodies when HAR is on | `attachNetworkCollector(page, { captureBodies: false })` when `captureHar` is true. Network rows keep URL/status/headers/timing; Content tab is empty (`bodyEncoding: "empty"`). Response bodies remain in the downloaded HAR. | [`lib/playwright-fetch.ts`](lib/playwright-fetch.ts) |
| Per-body timeout | Each `response.body()` is raced with a **5s** timeout; on timeout the entry gets an empty body and collection continues. | [`lib/network-collector.ts`](lib/network-collector.ts) (`BODY_READ_TIMEOUT_MS`) |
| Flush deadline | `flush()` stops accepting new response tasks, then waits at most **15s** for pending collectors before sorting and returning. | `FLUSH_TIMEOUT_MS` in `network-collector.ts` |

**What you should expect now**

- Costco + Capture HAR should complete in roughly the same order of magnitude as a normal check (often ~10s locally, still subject to the 60s API `maxDuration`).
- Network **Content** tab is empty for that check; use **Export → HAR** (JSON default or Zip) for bodies.
- Without Capture HAR, Content tab still captures bodies, but hung reads can no longer block the whole check beyond the timeouts above.

Related: headless Costco can also fail earlier with `net::ERR_HTTP2_PROTOCOL_ERROR` — see [Headless / ERR_HTTP2_PROTOCOL_ERROR](#headless--err_http2_protocol_error-e-g-costco).

Plan: [`docs/HAR_ZIP_IMPLEMENT_PLAN.md`](docs/HAR_ZIP_IMPLEMENT_PLAN.md).

#### Soft limit (`MAX_HAR_BYTES`)

| Item | Detail |
|------|--------|
| **What** | Soft size cap on the archive file (zip or `.har`) before returning it |
| **Default** | `45_000_000` (~45 MB) |
| **Where to change** | `MAX_HAR_BYTES` in [`lib/playwright-fetch.ts`](lib/playwright-fetch.ts) |
| **If exceeded** | Check succeeds; `har` / `harZipBase64` null; `harError` set; UI warning |

---

## Deployment (Vercel / Netlify)

For **production Playwright checks**, use a **VM or container** instead — see **[DEPLOYMENT.md](DEPLOYMENT.md)** (`scripts/deploy-vm.sh`, `scripts/deploy-container.sh`). Manual GitHub Actions SSH deploy to a VM is documented there as well (`workflow_dispatch` only).

### VM deploy (recommended for Playwright)

```bash
# First install or later app update (after git pull) — same command
./scripts/deploy-vm.sh
```

`deploy-vm.sh` is **safe to re-run** when the backend/app is updated:

- Stops the `url-checker` systemd unit if running, then `npm ci` + Chromium install + `npm run build`, then restarts the unit
- Installs **nginx** only if missing; manages **only** this app’s site (`/etc/nginx/sites-available/url-checker.conf`)
- Does **not** remove other nginx sites; preserves HTTPS configs written by `setup-https.sh`
- Skips rewriting the HTTP nginx site when the rendered config is unchanged
- Stock `sites-enabled/default`: see **[`NGINX_DISABLE_DEFAULT`](DEPLOYMENT.md#nginx_disable_default-stock-welcome-site-only)** in the deploy guide (not unlinked on shared hosts by default)

HTTPS (after DNS points at the VM):

```bash
./scripts/setup-https.sh checker.example.com --email ops@example.com
```

Full options, env vars, and troubleshooting: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

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

### `GET /api/config`

Returns server feature gates for the UI (`allowIgnoreCertErrors`, `allowCaptureHar`). Same values enforced by `POST /api/check`. Defaults are **allow** when the corresponding env vars are unset.

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
  },
  "ignoreCertErrors": false,
  "disableHttp2": false,
  "disableHttp3": false,
  "http11Only": false,
  "captureHar": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Absolute `http` or `https` URL |
| `headers` | `{ name, value }[]` | No | Extra headers applied to the Playwright browser context |
| `dnsOverride` | `{ host, ip }` | No | Force Chromium to resolve `host` to `ip` (must match URL hostname; private IPs blocked) |
| `ignoreCertErrors` | boolean | No | When `true`, Playwright context uses `ignoreHTTPSErrors` (self-signed / expired TLS). Default `false` / omitted. Rejected with **400** if server has `ALLOW_IGNORE_CERT_ERRORS` disabled |
| `disableHttp2` | boolean | No | Chromium `--disable-http2`. Default `false`. Rejected with **400** if `ALLOW_HTTP_PROTOCOL_CONTROLS` disabled |
| `disableHttp3` | boolean | No | Disable HTTP/3 via Chromium `--disable-quic` (no `--disable-http3`). Default `false`. Same gate |
| `http11Only` | boolean | No | Preset: expands to both disables (≈ HTTP/1.1 only). Default `false`. Same gate |
| `captureHar` | boolean | No | When `true`, record Playwright HAR and return `har` or `harZipBase64` per `harFormat`. Rejected with **400** if `ALLOW_CAPTURE_HAR` disabled |
| `harFormat` | `"json"` \| `"zip"` | No | Packaging when `captureHar` is true. Default **`json`**. `json` = embed / binaries as base64; `zip` = attach / binaries as files |

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
          "method": "GET",
          "status": 200,
          "contentType": "text/html; charset=UTF-8",
          "contentSize": 1256,
          "resourceType": "document",
          "date": "2026-08-20T20:18:00.123Z",
          "remoteIp": "93.184.216.34",
          "remotePort": 443,
          "httpVersion": "http/1.1",
          "timing": {
            "startTime": 0,
            "domainLookupStart": 1.2,
            "domainLookupEnd": 5.0,
            "connectStart": 5.1,
            "secureConnectionStart": 8.0,
            "connectEnd": 25.0,
            "requestStart": 25.1,
            "responseStart": 40.0,
            "responseEnd": 55.0
          }
        }
      ],
  "networkFailedRequests": [],
  "navigationTiming": {
    "fetchStart": 0.5,
    "domainLookupStart": 1.0,
    "domainLookupEnd": 4.0,
    "connectStart": 4.1,
    "connectEnd": 20.0,
    "secureConnectionStart": 8.0,
    "requestStart": 20.1,
    "responseStart": 35.0,
    "responseEnd": 50.0,
    "domInteractive": 80.0,
    "domContentLoadedEventStart": 82.0,
    "domContentLoadedEventEnd": 83.0,
    "domComplete": 100.0,
    "loadEventStart": 100.0,
    "loadEventEnd": 101.0,
    "redirectCount": 0,
    "type": "navigate"
  },
  "dnsOverride": {
    "host": "example.com",
    "ip": "203.0.113.10"
  },
  "ignoreCertErrors": false,
  "disableHttp2": false,
  "disableHttp3": false,
  "http11Only": false,
  "chromiumProtocolArgs": [],
  "http2FallbackApplied": false,
  "harFormat": null,
  "har": null,
  "harZipBase64": null,
  "harError": null,
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
| `networkRequests` | Observed responses with date, method, URL, host, remote IP/port, HTTP version, status, content type/size/type, timing, per-entry headers, and `body` / `bodyEncoding` / `bodyTruncated` for the Content tab (capped; see limits) |
| `networkFailedRequests` | Failed / aborted requests from Playwright `requestfailed` (method, URL, host, type, status `-1`, `failureText`, request headers). Empty array if none. **Not** a full HAR `status: -1` dump — see [Failed / incomplete requests](#failed--incomplete-requests) (included / excluded / cap). Max rows: `MAX_NETWORK_FAILED_ENTRIES` (default 500) |
| `navigationTiming` | Page `PerformanceNavigationTiming` snapshot, or `null` |
| `dnsOverride` | Applied force-resolve mapping, or `null` |
| `ignoreCertErrors` | Whether this check used Playwright `ignoreHTTPSErrors` |
| `disableHttp2` / `disableHttp3` / `http11Only` | Protocol restrictions applied for this check |
| `chromiumProtocolArgs` | Chromium launch args added (e.g. `["--disable-http2","--disable-quic"]`), or `[]` |
| `http2FallbackApplied` | `true` if navigation was retried with `--disable-http2` after `ERR_HTTP2_PROTOCOL_ERROR` |
| `harFormat` | `"json"` \| `"zip"` when HAR was requested; otherwise `null` |
| `har` | HAR 1.2 JSON text when `harFormat: "json"` and within limit; otherwise `null` |
| `harZipBase64` | `.har.zip` as base64 when `harFormat: "zip"` and within limit; otherwise `null` |
| `harError` | Why HAR download is unavailable (e.g. over `MAX_HAR_BYTES`); check still succeeds |
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
│   ├── api/config/route.ts   # GET /api/config (feature gates)
│   ├── globals.css           # UI styles
│   ├── layout.tsx
│   └── page.tsx              # Main UI + submit flow
├── components/
│   ├── ContentPreview.tsx
│   ├── ExportMenu.tsx
│   ├── HeaderEditor.tsx
│   ├── HeadersPanel.tsx
│   ├── HeadersTabs.tsx       # Shared Request/Response/Content/Timing tabs
│   ├── ThemeProvider.tsx     # Light/dark theme context + persistence
│   ├── ThemeToggle.tsx       # Header theme switch control
│   ├── TimingWaterfall.tsx   # Resource / Navigation timing waterfall graph
│   ├── NetworkRequestsPanel.tsx
│   ├── NetworkFailedRequestsPanel.tsx
│   ├── ResourceSummary.tsx
│   └── UrlForm.tsx           # URL, DNS, custom headers, ignore cert, capture HAR
├── lib/
│   ├── export.ts             # Client-side export builders (JSON/PNG/HTML/CSV)
│   ├── extract-resources.ts  # DOM URL extraction
│   ├── network-collector.ts  # Playwright response + requestfailed log
│   ├── playwright-fetch.ts   # Browser launch + capture (+ MAP args, navigationTiming)
│   ├── feature-flags.ts      # ALLOW_IGNORE_CERT_ERRORS / ALLOW_CAPTURE_HAR / ALLOW_HTTP_PROTOCOL_CONTROLS (default allow)
│   ├── types.ts              # Shared request/response types
│   └── validate.ts           # URL / header / DNS override guards
├── scripts/
│   ├── deploy-vm.sh          # VM install/build/systemd; re-runnable for updates
│   ├── setup-https.sh        # Post-deploy Let's Encrypt + nginx HTTPS (domain arg)
│   └── deploy-container.sh   # Docker Compose build/up (optional APP_URL)
├── deploy/
│   ├── url-checker.service   # systemd unit template
│   ├── nginx-url-checker.conf # nginx HTTP reverse-proxy template (shared-host safe)
│   └── nginx-url-checker-https.conf # nginx HTTPS + redirect template
├── .github/workflows/
│   └── deploy-vm-ssh.yml     # Manual SSH VM deploy
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
| Max network entries | 2,000 | Cap collected **responses** (`networkRequests`) |
| **`MAX_NETWORK_FAILED_ENTRIES`** | **500** (env; clamp 1–10000) | Cap **`requestfailed`** rows (`networkFailedRequests`). Invalid/empty → 500. Excess failures dropped for UI/API; check still succeeds. See [Failed / incomplete requests](#failed--incomplete-requests). |
| Max network body bytes | 512,000 | Per-response body capture for Content tab (text or base64); truncated beyond this. **Skipped entirely when Capture HAR is on** (bodies live in the HAR) |
| Network body read timeout | 5,000 ms | Per `response.body()`; prevents hang on streaming/analytics responses |
| Network collector flush timeout | 15,000 ms | Max wait for in-flight collectors before continuing the check |
| **`MAX_HAR_BYTES`** | **45,000,000** (~45 MB) | Soft HAR archive size cap in [`lib/playwright-fetch.ts`](lib/playwright-fetch.ts). Over limit → `har` / `harZipBase64` null + `harError`; **page results still succeed**. See [HAR capture](#har-capture-playwright-session-archive). |
| Content size | Prefer `Content-Length`; else response body length when available | Shown in network table |
| DNS override | Chromium `--host-resolver-rules=MAP host ip` | Process-wide for that browser instance |
| API `maxDuration` | 60s | Next.js route limit |
| `ALLOW_IGNORE_CERT_ERRORS` | allow when unset | Server gate; disable with `0`/`false`/`no`/`off`. See [DEPLOYMENT.md](DEPLOYMENT.md#feature-gates-env--default-allow) |
| `ALLOW_CAPTURE_HAR` | allow when unset | Same for HAR capture |
| `ALLOW_HTTP_PROTOCOL_CONTROLS` | allow when unset | Same for HTTP/2 / HTTP/3 / HTTP/1.1-only controls |

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
- **Ignore certificate errors** is **off** per check by default; the server **allows** the option when `ALLOW_IGNORE_CERT_ERRORS` is unset. Set `ALLOW_IGNORE_CERT_ERRORS=0` to hide the UI control and reject API requests that ask for it. Enabling ignore only relaxes TLS verification inside Playwright and does not weaken SSRF / private-IP guards.
- **Capture HAR** is **off** per check by default; the server **allows** the option when `ALLOW_CAPTURE_HAR` is unset. Set `ALLOW_CAPTURE_HAR=0` to disable. When on, default format is **`json`** (optional **`zip`**); HAR is written only to an OS temp path during the check, returned in the API response, then deleted — not stored in the app directory or a database.
- **HTTP protocol controls** are **off** per check by default; the server **allows** them when `ALLOW_HTTP_PROTOCOL_CONTROLS` is unset. Set `ALLOW_HTTP_PROTOCOL_CONTROLS=0` to disable. Only allowlisted Chromium args (`--disable-http2`, `--disable-quic`) are applied — clients cannot pass arbitrary launch flags.
- HTML preview uses an empty `sandbox` attribute so scripts do not execute in the UI.

This is not a full multi-tenant hardening suite. Do not expose an open instance to the public internet without auth, rate limits, and further SSRF review.

---

## Limitations and out of scope

- No authentication, user accounts, or audit log.
- No persistent check history (results are memory-only; theme preference is the only durable browser store — see [How content is stored](#how-content-is-stored)).
- One Chromium browser per request (no shared pool).
- `networkidle` is not required for success (sites with perpetual analytics/websockets would otherwise hang).
- Screenshot + large HTML payloads can make JSON responses heavy.
- Sites that block headless browsers, require interactive CAPTCHAs, or depend on special client TLS may fail or look incomplete.
- DNS override maps a single exact hostname (no multi-host or wildcard UI yet).
- Third-party hosts are never remapped by the DNS override.
- Export is client-side only (no server archive store); Network CSV is a metadata index (no header/body cells); HAR is optional via **Capture HAR** as `.har` (default) or `.har.zip` subject to `MAX_HAR_BYTES` (see [HAR capture](#har-capture-playwright-session-archive)).
- On Capture HAR checks, Network Content bodies are omitted by design so heavy sites cannot hang on `response.body()` flush (see [Capture HAR hang on heavy sites](#capture-har-hang-on-heavy-sites-e-g-costco)).
- HTTP protocol controls only restrict Chromium negotiation via `--disable-http2` / `--disable-quic`; they cannot force HTTP/2 or HTTP/3, and Playwright has no per-request `httpVersion` API (see [HTTP protocol controls](#http-protocol-controls)).
- No PDF export or editable HTML workspace.
- Resource summary unique-URL totals are not expected to equal Network request row counts (different sources; see [Resource summary vs Network requests](#resource-summary-vs-network-requests)).
- **Failed / incomplete requests** only lists Playwright `requestfailed` during the check (capped by `MAX_NETWORK_FAILED_ENTRIES`). It is **not** a full list of HAR `status: -1` entries; incomplete-at-flush and post-flush failures are excluded (see [Failed / incomplete requests](#failed--incomplete-requests)).

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
