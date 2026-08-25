# NetLog capture via Playwright — implement plan (review only)

**Status:** Implemented (review decisions locked below).  
**Goal:** Optionally capture a Chromium **NetLog** dump for the same Playwright check session, return it in the API/UI for download (ephemeral, no server persistence), alongside existing Network / Failed / HAR outputs.

**Why:** HAR and Playwright network events are application-layer views. NetLog is Chromium’s internal network stack event stream (DNS, sockets, TLS, HTTP/2/3 frames, proxy, certs, etc.) and is the artifact Chromium teams ask for when diagnosing protocol / CDN / connection failures. Viewable in [NetLog Viewer](https://netlog-viewer.appspot.com/) (or historically `chrome://net-export` load).

---

## Background (research summary)

### What Playwright exposes

| Capability | Supported? |
|------------|------------|
| First-class `recordNetLog` / context option | **No** |
| Playwright `recordHar` | **Yes** (already used) |
| Pass Chromium flags at launch | **Yes** — `chromium.launch({ args })` |

There is **no** Playwright API for NetLog. Capture is Chromium-only via launch switches (same pattern as `--disable-http2` / `--disable-quic`).

### Chromium switches (source of truth)

Official: [How to capture a NetLog dump](https://www.chromium.org/for-testers/providing-network-details/).

| Switch | Role |
|--------|------|
| `--log-net-log=/abs/path/netlog.json` | Start writing NetLog to that path from browser startup until process exit |
| `--net-log-capture-mode=Default` | Strip private info (cookies / auth / raw bytes) — **Chromium default when mode flag omitted** |
| `--net-log-capture-mode=IncludeSensitive` | Include cookies / auth headers; still not full socket bytes |
| `--net-log-capture-mode=Everything` | Include raw bytes (largest / most sensitive) |
| `--net-log-max-size-mb=N` | Cap log size in MB (Chromium truncates / stops growing) — available M117+ |
| `--net-log-duration=N` | Stop logging after N seconds (M137+) — **not recommended for v1** (check duration varies) |

### Critical lifecycle difference vs HAR

| Artifact | Flushed when |
|----------|----------------|
| Playwright HAR (`recordHar`) | **`BrowserContext.close()`** |
| Chromium NetLog (`--log-net-log`) | **Browser process exit** (`browser.close()`) |

Today [`lib/playwright-fetch.ts`](../lib/playwright-fetch.ts) does:

1. Capture page artifacts  
2. `context.close()` → read HAR  
3. `return` (then `finally` → `browser.close()`)

For NetLog, the file may be **incomplete or unreadable until after `browser.close()`**. Implementation must:

1. `context.close()` (HAR flush if any)  
2. `browser.close()` (NetLog flush)  
3. **Then** `stat` / `readFile` NetLog  
4. Cleanup temp dir  
5. Return response  

Do **not** read NetLog between `context.close()` and `browser.close()`.

### What NetLog is *not*

- Not a HAR 1.2 file — different schema; DevTools “Save all as HAR” / Playwright HAR remain separate.
- Not a packet capture (tcpdump/Wireshark) — application-level Chromium events; optional socket byte dumps in `Everything` mode.
- Not Firefox/WebKit — Chromium-only (URL Checker already uses Chromium only).

### HAR vs NetLog (product positioning)

| | HAR | NetLog |
|--|-----|--------|
| Layer | Page / resource timeline (HAR 1.2) | Chromium network stack events |
| Best for | Replay, resource bodies, DevTools-like inspection | HTTP/2/3, TLS, DNS, socket, CDN protocol failures |
| Playwright API | `recordHar` | Launch args only |
| Typical viewer | Chrome DevTools, HAR tools, `scripts/replay-har.mjs` | [netlog-viewer.appspot.com](https://netlog-viewer.appspot.com/) |
| Size | Soft-capped today (`MAX_HAR_BYTES` ~45 MB) | Can grow **very** large with `Everything` |

Users may enable **neither, either, or both** on one check.

---

## Proposed product surface (v1)

### UI (`UrlForm`)

Place under **Custom headers**, near **Capture HAR** (same “debug artifact” cluster):

1. Checkbox **Capture NetLog** — default **off**
2. When checked, optional **Capture mode** radios (or select):

| Label (UI) | API value | Chromium flag |
|------------|-----------|---------------|
| **Strip private** (default) | `default` | omit mode flag **or** `--net-log-capture-mode=Default` |
| **Include sensitive** | `includeSensitive` | `--net-log-capture-mode=IncludeSensitive` |
| **Everything** (raw bytes) | `everything` | `--net-log-capture-mode=Everything` |

Short hint: “Chromium network stack log for [NetLog Viewer](https://netlog-viewer.appspot.com/). Large / sensitive — off by default.”

Hide the whole control when `ALLOW_CAPTURE_NETLOG` is disabled (`GET /api/config`).

### API (`POST /api/check`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `captureNetLog` | boolean | `false` | Opt-in |
| `netLogCaptureMode` | `"default" \| "includeSensitive" \| "everything"` | `"default"` | Ignored unless `captureNetLog` |

Reject with **400** if `captureNetLog: true` and `ALLOW_CAPTURE_NETLOG` is off (same pattern as HAR).

### Response (`CheckResponse`)

| Field | Type | Notes |
|-------|------|-------|
| `netLogCaptureMode` | mode \| `null` | Echo of effective mode when capture requested; else `null` |
| `netLogBase64` | `string \| null` | Full NetLog JSON file as base64 (JSON transport), or see packaging option below |
| `netLogError` | `string \| null` | Soft failure (over size / missing file) — **check still succeeds** like `harError` |

Meta strip: show “NetLog: on (mode)” when captured; Export menu: **Download NetLog (.json)** when `netLogBase64` present; show `netLogError` when set.

### Packaging (locked: A)

| Option | Approach | Status |
|--------|----------|--------|
| **A** | Raw JSON → `netLogBase64` → download `*.json` | **Locked** — open in [NetLog Viewer](https://netlog-viewer.appspot.com/) |
| B | Gzip → `netLogGzipBase64` | Deferred |
| C | Zip wrapper | Deferred |

### Soft limits

| Knob | Default (proposal) | Role |
|------|--------------------|------|
| `MAX_NETLOG_BYTES` | `45_000_000` (~45 MB) | After close: if file size &gt; limit → set `netLogError`, omit payload (same UX as HAR) |
| `--net-log-max-size-mb` | Derive from `MAX_NETLOG_BYTES` (e.g. `Math.max(1, Math.floor(MAX_NETLOG_BYTES / 1_000_000))` → **45**) | Chromium-side cap so the process does not write unbounded disk |

Env override: `MAX_NETLOG_BYTES` (document in `.env.example` / DEPLOYMENT), parallel to `MAX_HAR_BYTES`.

### Feature gate

| Env | Default | Behavior |
|-----|---------|----------|
| `ALLOW_CAPTURE_NETLOG` | allow when unset | `0`/`false`/`no`/`off` hides UI + rejects API |

Add to `lib/feature-flags.ts`, `FeatureFlags`, `GET /api/config`, deploy comments.

### Persistence / security (align with HAR)

- Temp dir: `mkdtemp(tmpdir(), "url-checker-netlog-")` → file e.g. `session.netlog.json`
- Never write under the app directory or DB
- Delete temp dir after read (success or error paths / `finally`)
- Warn in README: `includeSensitive` / `everything` may contain cookies, tokens, Authorization headers, and (for everything) decrypted traffic bytes — treat downloads as secrets

### Interaction with other options

| Combo | Behavior |
|-------|----------|
| NetLog + HAR | Both allowed; independent temp dirs; both appear in Export |
| NetLog + HTTP/2 fallback retry | **Each launch needs its own NetLog path.** Keep the log from the **successful (final) attempt** only; discard failed attempt’s temp dir. Document that early `ERR_HTTP2_PROTOCOL_ERROR` attempt is not in the downloaded file unless we later add “merge” (out of scope v1). |
| NetLog + Capture HAR body skip | Unchanged — body skip is HAR-driven only |
| NetLog alone | Network panel still captures bodies (unless HAR also on) |

### Out of scope (v1)

- In-app NetLog viewer / timeline UI (download + external viewer only)
- Converting NetLog → HAR
- `chrome://net-export` page automation (fragile; launch flags are enough)
- `--net-log-duration`
- Firefox/WebKit
- Streaming / chunked NetLog over the API (multipart) — keep single JSON response like HAR
- Incomplete-at-flush network rows (orthogonal)

---

## Implementation sketch

### Launch args (when `captureNetLog`)

```ts
const netLogDir = await mkdtemp(join(tmpdir(), "url-checker-netlog-"));
const netLogPath = join(netLogDir, "session.netlog.json");
const maxMb = Math.max(1, Math.floor(MAX_NETLOG_BYTES / 1_000_000));

const netLogArgs = [
  `--log-net-log=${netLogPath}`,
  `--net-log-max-size-mb=${maxMb}`,
  ...(mode === "includeSensitive"
    ? ["--net-log-capture-mode=IncludeSensitive"]
    : mode === "everything"
      ? ["--net-log-capture-mode=Everything"]
      : []), // default = strip private
];

await chromium.launch({
  headless: true,
  args: [
    ...hostResolverArgs(dnsOverride),
    ...protocol.chromiumProtocolArgs,
    ...netLogArgs,
  ],
});
```

### Close / read order (must change slightly)

```text
… navigate, screenshot, flush network …
context.close()          # HAR flush
browser.close()          # NetLog flush  ← move before NetLog read; today close is only in finally
read HAR (if any)
read NetLog (if any)     # after browser.close
cleanup both temp dirs
return CheckResponse
```

Refactor so `browser.close()` is explicit before artifact reads (keep `finally` as safety net for crashes).

### Types (`lib/types.ts`)

```ts
export type NetLogCaptureMode = "default" | "includeSensitive" | "everything";

// CheckRequest
captureNetLog?: boolean;
netLogCaptureMode?: NetLogCaptureMode;

// CheckResponse
netLogCaptureMode: NetLogCaptureMode | null;
netLogBase64: string | null;
netLogError: string | null;
```

### Export (`lib/export.ts` + `ExportMenu`)

- `exportNetLog(result)` → decode base64 → `Blob` `application/json` → filename `url-checker-netlog-<host>-<ts>.json`
- Light JSON export: strip `netLogBase64` (like screenshot / HAR bodies) so “JSON (light)” stays usable
- Full JSON keeps `netLogBase64`

### Files to touch (checklist)

- [ ] `docs/NETLOG_CAPTURE_IMPLEMENT_PLAN.md` (this file)
- [ ] `lib/types.ts` — request/response + feature flag field
- [ ] `lib/feature-flags.ts` + `GET /api/config`
- [ ] `app/api/check/route.ts` — validate + pass through; 400 when gated
- [ ] `lib/playwright-fetch.ts` — temp dir, launch args, close order, read + soft limit + cleanup; HTTP/2 retry keeps final attempt only
- [ ] `lib/export.ts` + `components/ExportMenu.tsx`
- [ ] `components/UrlForm.tsx` — checkbox + mode radios
- [ ] `app/page.tsx` — meta echo if needed
- [ ] `.env.example`, `docker-compose.yml`, `deploy/url-checker.service`
- [ ] `README.md`, `DEPLOYMENT.md`, `CHANGELOG.md`
- [ ] Deploy script headers (`deploy-vm.sh` / `deploy-container.sh`) brief mention

### Verification (manual)

1. Check with Capture NetLog off → no `netLog*` payload / no download.
2. Mode **default** on a small site → download JSON; open in NetLog Viewer; events present for navigation.
3. Mode **everything** → larger file; confirm soft limit / `--net-log-max-size-mb` behavior on a heavy page.
4. Over-limit path → `netLogError` set, page results still present.
5. NetLog + HAR both on → both downloads work.
6. Costco / HTTP/2 fallback path → NetLog from **retry** attempt only; check completes.
7. `ALLOW_CAPTURE_NETLOG=0` → UI hidden; API 400 if forced.
8. Temp dirs gone after check (`/tmp/url-checker-netlog-*`).

---

## Risks / considerations

1. **Size & memory** — NetLog JSON + base64 in one API response can OOM or hit reverse-proxy body limits (`CLIENT_MAX_BODY` / nginx). Mitigate with `MAX_NETLOG_BYTES` + Chromium max-size-mb; document raising nginx limits if needed.
2. **Privacy** — modes above default are secret-bearing; default UI should stay **Strip private**; warn next to radios.
3. **Incomplete file if close order wrong** — must close browser before read (see lifecycle).
4. **HTTP/2 double launch** — first attempt’s NetLog discarded; document clearly.
5. **Playwright arg caution** — Chromium docs say custom args are “at your own risk”; `--log-net-log` is widely used and should not break automation, but worth one smoke test after Chromium upgrades.
6. **Concurrent checks** — unique `mkdtemp` paths avoid collisions (same as HAR).
7. **Disk** — ephemeral under OS temp; clean up even on throw.
8. **Viewer CORS / local files** — NetLog Viewer is a static app that loads user-selected files locally; no server upload required for normal use.

---

## Locked decisions

| # | Topic | Decision |
|---|--------|----------|
| 1 | Packaging | **A** — `netLogBase64` → download `.json` (open in [NetLog Viewer](https://netlog-viewer.appspot.com/)) |
| 2 | Default capture mode | **`default`** (strip private) |
| 3 | Soft limit | **`MAX_NETLOG_BYTES = 45_000_000`** + matching `--net-log-max-size-mb` |
| 4 | Feature gate | **`ALLOW_CAPTURE_NETLOG`** default allow |
| 5 | UI placement | Next to Capture HAR |
| 6 | Both HAR + NetLog | Allowed |
| 7 | HTTP/2 retry NetLog | **Final attempt only** |
| 8 | In-app viewer | **No** (v1 download only) |
| 9 | Light JSON export | Strip `netLogBase64` |

---

## Implementation checklist

- [x] Lock decisions
- [x] Types + feature flag + API validation
- [x] `playwright-fetch` lifecycle (close order + args + read)
- [x] Export + UrlForm + meta
- [x] Docs / env / deploy comments
