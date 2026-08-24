# HAR include images (binary attach + zip) — implement plan

**Branch:** `har_include_images`  
**Goal:** When **Capture HAR** is on, record a Playwright session archive where binary bodies (images, fonts, etc.) stay **raw bytes inside a `.har.zip`**, not base64-inlined inside a single HAR JSON file.

## Background

| Mode | What Playwright does | Binary in archive? |
|------|----------------------|--------------------|
| Current `content: "embed"` + `.har` | Bodies inlined in HAR JSON; binary → `encoding: "base64"` | No — base64 text in JSON |
| Target `content: "attach"` + `.har.zip` | HAR JSON references `_file`; bodies as zip entries | Yes — raw files in zip |

HAR 1.2 JSON cannot hold raw binary; attach+zip is the supported way to keep binaries as binary.

Wire transport still uses base64 **only** inside `POST /api/check` JSON (`harZipBase64`). After the user downloads `.har.zip`, unzipped resource files are real binaries.

## Design

1. **Record:** `recordHar: { path: session.har.zip, mode: "full", content: "attach" }`
2. **Response fields:**
   - `harZipBase64: string | null` — zip bytes as base64 for JSON transport
   - `harError: string | null` — unchanged semantics (check still succeeds if over limit)
   - **Remove** `har: string | null` (JSON HAR text) on this branch — download is zip-only
3. **Soft limit:** rename conceptually to `MAX_HAR_BYTES` (default `25_000_000`) applied to zip **file size** before base64 encoding
4. **Client:** Export / meta download `*.har.zip` (`application/zip`)
5. **Ephemeral temp:** unchanged — OS temp dir, delete after read

## Task list

- [x] Create branch `har_include_images`
- [x] Add this plan file under `docs/`
- [x] Update `lib/types.ts` — `harZipBase64`; drop `har`
- [x] Update `lib/playwright-fetch.ts` — attach + `.zip`, byte limit, base64 zip
- [x] Update `app/api/check/route.ts` — error payload fields
- [x] Update `lib/export.ts` — `exportHar` → zip blob; light export clears `harZipBase64`
- [x] Update `components/ExportMenu.tsx` + `app/page.tsx` — zip download UX copy
- [x] Update `UrlForm` hint if needed (zip / binaries)
- [x] Update README.md, CHANGELOG.md, DEPLOYMENT.md
- [x] Lint touched TS files

## Considerations / risks

1. **Tooling:** Some tools want a lone `.har`; Playwright zip may need unzip (`har.har` + resource files) before import.
2. **API break:** Clients using `result.har` must switch to `harZipBase64`.
3. **Memory:** Zip → Buffer → base64 in JSON (~4/3 size). Soft byte limit still critical.
4. **Size:** Often smaller than embed+base64 for image-heavy pages, but not always small.
5. **Security:** Same as before — temp only, no app-disk persistence; bodies may contain cookies/tokens.

## Dual format (added)

Both modes are supported when Capture HAR is on:

| UI / API | Playwright | Field | Binaries |
|----------|------------|-------|----------|
| Zip (default) | `attach` + `.har.zip` | `harZipBase64` | Files in zip |
| JSON | `embed` + `.har` | `har` | Base64 in JSON |

Request: `captureHar: true` + optional `harFormat: "zip" | "json"` (default `zip`).
