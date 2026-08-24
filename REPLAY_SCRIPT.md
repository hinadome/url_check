# HAR Replay Script

Guide for [`scripts/replay-har.mjs`](scripts/replay-har.mjs): replay a captured HTTP session from a HAR (or URL Checker HAR zip / base64) using Playwright `page.routeFromHAR`, optionally verify offline replay, and capture progressive screenshots.

---

## What this is for

URL Checker (and browser DevTools) can export a **network archive**. That archive is not a “Save Page As” folder. Replay means:

1. Open the original page URL in Chromium.
2. Intercept network requests.
3. Satisfy matching requests from the HAR (HTML, CSS, JS, images, XHR, etc.).

If a request is **not** in the HAR, Playwright may still hit the **live network** unless you use `--offline`.

---

## Prerequisites

From the repo root (Playwright is already a dependency):

```bash
npm install          # installs Playwright package
npx playwright install chromium   # if Chromium is missing
```

Run the script with Node:

```bash
node scripts/replay-har.mjs --help
```

---

## Supported inputs

| Input | Typical source | CLI |
|-------|----------------|-----|
| `*.har.zip` | URL Checker **Capture HAR** with `harFormat: zip` (`content: attach`) | `--zip`, `--unzip`, or path auto-detect |
| Extracted zip dir (`har.har` + body files) | Unzipped attach archive | `--dir` |
| `*.har` (JSON, bodies embedded) | URL Checker `harFormat: json`, or **Chrome/Edge/Firefox DevTools** export | `--har`, `--devtools`, or path |
| Raw `harZipBase64` text | API field from `POST /api/check` | `--base64-file`, `--base64-stdin` |
| Check-result JSON | Export / saved API response with `harZipBase64` or `har` | `--json`, or auto-detect |

### Archive layouts

**Zip (attach)** — Playwright session zip:

```text
export.har.zip
├── har.har              # HAR JSON; bodies referenced via _file
└── <hash>.png / .js …   # raw response bodies
```

**Single `.har` (embed)** — HAR 1.2 JSON with `log.entries`; binary bodies usually as `content.text` + `encoding: "base64"`.

**DevTools** — same HAR JSON shape; `log.creator.name` is often `WebInspector` (Chrome/Edge) or `Firefox`. Prefer **Save all as HAR with content** so response bodies are present.

---

## Quick start

```bash
# DevTools or URL Checker .har
node scripts/replay-har.mjs --har ~/Downloads/site.har

# Same, with aliases / auto-detect
node scripts/replay-har.mjs --devtools ~/Downloads/site.har
node scripts/replay-har.mjs ~/Downloads/site.har

# URL Checker zip
node scripts/replay-har.mjs --zip ~/Downloads/url-checker-example.com-….har.zip

# Prove responses come from the HAR (no live fallback)
node scripts/replay-har.mjs --har ~/Downloads/site.har --offline

# Progressive screenshots while replaying
node scripts/replay-har.mjs --har ~/Downloads/site.har --offline --screenshots ./out
```

Without `--headless` and without `--screenshots`, a headed browser stays open until you close it.

---

## CLI reference

### Input modes (pick exactly one)

| Flag | Description |
|------|-------------|
| `<path>` or `--file <path>` | Auto-detect: `.har.zip` / zip magic, HAR JSON, check JSON, or bare base64 |
| `--har <path.har>` | Single HAR JSON (URL Checker embed **or** DevTools) |
| `--devtools <path.har>` | Alias of `--har` |
| `--zip <path.har.zip>` | Playwright attach zip (do not unzip) |
| `--dir <extractedDir>` | Folder containing `har.har` + body files |
| `--unzip <path.har.zip>` | Unzip to a temp dir, then replay from `har.har` |
| `--base64-file <file>` | File with raw base64, data URL, HAR JSON, or check JSON |
| `--json <file>` | Check-result JSON (`harZipBase64` and/or `har`) |
| `--base64-stdin` | Same as above, read from stdin (e.g. `pbpaste \| …`) |

### Options

| Flag | Description |
|------|-------------|
| `--url <url>` | Page to open. Default: first document/`text/html` URL in the HAR (see [URL selection](#url-selection)) |
| `--offline` | `routeFromHAR({ notFound: "abort" })` — fail if a request is missing from the HAR |
| `--headless` | Run Chromium without a window |
| `--screenshots [dir]` | Progressive PNG captures; default dir `./har-screenshots` |
| `--scroll-screenshots` | Also capture viewport frames while scrolling (implies `--screenshots` if omitted) |
| `-h`, `--help` | Show usage |

---

## How replay works

1. Resolve input → a path Playwright understands (`.har`, `.har.zip`, or `har.har` in a folder).
2. For plain HAR files, validate `log.entries`, detect creator (DevTools vs Playwright), and warn on low body coverage or missing HTML documents.
3. Launch Chromium → new context (viewport 1280×720 when screenshots are enabled).
4. `page.routeFromHAR(harPath, { update: false, notFound?: "abort" })`.
5. Navigate to the target URL (`load`, or progressive milestones when screenshots are on).
6. Optionally write progressive screenshots; optionally keep the window open.

### URL selection

`firstDocumentUrlFromHarData` picks a navigation URL in this order:

1. Entry with `_resourceType === "document"` (common in DevTools / Playwright).
2. Entry whose `response.content.mimeType` includes `html`.
3. `log.pages[].title` **only if** that string is an `http(s)` URL **and** appears as some `request.url` in the HAR (avoids Chrome page titles that were never recorded as requests).
4. First `http(s)` request URL (last resort).

If there is **no** document/HTML entry and you did not pass `--url`, the script exits with an error (typical of XHR-only DevTools exports).

### Offline vs online

| Mode | Behavior |
|------|----------|
| Default | Missing URLs may go to the live network |
| `--offline` | Missing URLs abort — strongest proof the page is served from the HAR |

---

## Verifying the page loaded from the HAR

1. **Use `--offline`** — if the page loads, matching responses came from the archive.
2. **Disconnect the network** and replay — success implies HAR-backed responses.
3. **Confirm the document URL exists** in `log.entries[].request.url`.
4. **Spot-check unique content** (title, HTML snippet, API field) that matches the capture, not the live site.

A headed replay **without** `--offline` can mix live traffic for URLs absent from the HAR, so a good-looking page alone is not proof.

---

## Progressive screenshots

### CLI

```bash
node scripts/replay-har.mjs --har ~/Downloads/site.har --offline --screenshots ./out

# milestones + scroll frames
node scripts/replay-har.mjs --har ~/Downloads/site.har --offline \
  --screenshots ./out --scroll-screenshots
```

When `--screenshots` is set, the browser runs headless for stable captures and exits after writing files.

### Output files (typical)

| File | When |
|------|------|
| `01-commit.png` | After navigation reaches `commit` |
| `02-domcontentloaded.png` | After `DOMContentLoaded` |
| `03-load.png` | After `load` |
| `04-networkidle.png` | After `networkidle` (skipped with a warning if not reached in time) |
| `05-scroll-01.png` … | Viewport frames if `--scroll-screenshots` |
| `NN-fullpage.png` | Full-page PNG at the end |

### Programmatic API

```js
import {
  generateProgressiveScreenshots,
  captureScrollScreenshots,
  replayFromHarPath,
} from "./scripts/replay-har.mjs";

// Full replay + screenshots
await replayFromHarPath("/path/to/site.har", {
  offline: true,
  screenshots: "./out",
  scrollScreenshots: true,
});

// Or drive an existing Playwright page
await generateProgressiveScreenshots(page, {
  outDir: "./out",
  url: "https://example.com/", // omit if already navigated
  scroll: true,
  // stages: ["commit", "domcontentloaded", "load", "networkidle", "fullpage"],
});
```

`generateProgressiveScreenshots(page, options)`:

| Option | Type | Description |
|--------|------|-------------|
| `outDir` | string | Directory created if missing |
| `url` | string? | If set, navigates progressively and snaps at each milestone |
| `timeout` | number? | Navigation / wait timeout (default 60s) |
| `scroll` | boolean? | Capture scroll viewport frames before full-page |
| `stages` | string[]? | Subset/order of `commit`, `domcontentloaded`, `load`, `networkidle`, `fullpage` |

---

## Base64 / API session replay

URL Checker returns zip bytes as `harZipBase64` inside JSON (transport only). After download as `.har.zip`, binaries are real files inside the zip.

```bash
# Check-result JSON that includes harZipBase64
node scripts/replay-har.mjs --json ./url-checker-….json --offline

# Raw base64 blob in a text file
node scripts/replay-har.mjs --base64-file ./harZipBase64.txt --offline

# Clipboard / pipe
pbpaste | node scripts/replay-har.mjs --base64-stdin --offline
```

Helpers:

| Function | Role |
|----------|------|
| `extractHarZipBase64(input)` | Pull base64 from raw string, data URL, or JSON with `harZipBase64` |
| `writeHarZipFromBase64(input)` | Decode to a temp `session.har.zip` |
| `resolveSessionInput(input, { sourcePath })` | Auto-resolve HAR / zip / base64 / check JSON → `{ harPath, cleanupDir, kind }` |
| `replayFromBase64(input, options)` | Decode + `replayFromHarPath` |

`resolveSessionInput` / `--base64-file` also accept a **HAR JSON** file and will replay it as `--har` would (auto-detect).

---

## Option cheat sheet (conceptual)

| Goal | Approach |
|------|----------|
| Replay zip as-is | `--zip path.har.zip` |
| Inspect/edit bodies, then replay | `unzip` → `--dir /tmp/har-session` or `--unzip path.har.zip` |
| Replay DevTools / embed `.har` | `--har` / `--devtools` / bare path |
| Replay API `harZipBase64` | `--base64-file` / `--json` / `--base64-stdin` |
| Prove HAR-only | `--offline` |
| Capture load progression | `--screenshots [dir]` (+ `--scroll-screenshots`) |

---

## Exported functions (module)

Import from `scripts/replay-har.mjs` (ESM):

| Export | Purpose |
|--------|---------|
| `inspectHar(data)` | Creator/source, entry count, body coverage |
| `describeHarSource(info)` | Human-readable source label |
| `firstDocumentUrlFromHarData(data)` | Default navigation URL |
| `resolveSessionInput(input, opts)` | Normalize text/JSON → HAR path |
| `extractHarZipBase64(input)` | Base64-only extractor |
| `writeHarZipFromBase64(input)` | Temp zip from base64 |
| `openInputPath(filePath)` | Auto-detect file on disk |
| `replayFromHarPath(harPath, options)` | Main replay entry |
| `replayFromBase64(input, options)` | Base64/JSON → replay |
| `generateProgressiveScreenshots(page, options)` | Milestone (+ optional scroll) PNGs |
| `captureScrollScreenshots(page, outDir, options)` | Scroll viewport frames only |

`replayFromHarPath` options: `url`, `offline`, `headless`, `screenshots`, `scrollScreenshots`, `keepOpen`.

---

## DevTools export tips

1. Open DevTools → **Network**.
2. Reload so the document and assets appear.
3. Right-click the list → **Save all as HAR with content**.
4. Replay with `--har` / path / `--devtools`.

Common failures:

| Symptom | Cause | Fix |
|---------|--------|-----|
| `HAR has 0 entries` | Empty/corrupt export | Re-capture after a real navigation |
| `No document/HTML entry` | XHR-only or partial export | Full page load + export with content; or `--url` to a recorded request |
| Page empty / broken | Headers-only HAR (few bodies) | Use “with content”; check body % in script logs |
| Works online, fails `--offline` | Some assets not in HAR | Re-capture; or accept live fallback without `--offline` |

---

## Limits and expectations

- Replay reconstructs **network responses**, not a perfect offline clone of every site behavior (cookies, anti-bot, post-load randomness, service workers, etc. may differ).
- Only URLs fetched during the original capture can be served from the HAR.
- Chrome DevTools “Import HAR” expects a single embed `.har`; Playwright **attach** `.har.zip` is best replayed with this script, not DevTools import.
- Soft size limits inside URL Checker (`MAX_HAR_BYTES`) may omit HAR from the API (`harError`) even when the page check succeeds — there is then nothing to replay.

---

## Related docs

- [`README.md`](README.md) — HAR capture (`zip` / `json`), export, API fields `har` / `harZipBase64`
- [`docs/HAR_ZIP_IMPLEMENT_PLAN.md`](docs/HAR_ZIP_IMPLEMENT_PLAN.md) — attach zip design notes
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — feature gate `ALLOW_CAPTURE_HAR`

---

## Examples (copy-paste)

```bash
# 1) DevTools HAR, offline, headed inspect
node scripts/replay-har.mjs --devtools ~/Downloads/enr.elections.ca.har --offline

# 2) URL Checker zip
node scripts/replay-har.mjs --zip ~/Downloads/url-checker-www.example.com-….har.zip --offline

# 3) Unzip attach archive, inspect files, replay
unzip -d /tmp/har-session ~/Downloads/url-checker-….har.zip
ls /tmp/har-session   # har.har + body files
node scripts/replay-har.mjs --dir /tmp/har-session --offline

# 4) Progressive screenshots
node scripts/replay-har.mjs \
  --har ~/Downloads/site.har \
  --offline \
  --screenshots ./har-screenshots \
  --scroll-screenshots

# 5) From API base64 field saved to disk
node scripts/replay-har.mjs --base64-file ./harZipBase64.txt --url https://www.example.com/ --offline
```
