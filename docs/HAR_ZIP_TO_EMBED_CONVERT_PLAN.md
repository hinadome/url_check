# HAR format converter (zip ↔ embed) — implement plan

**Status:** implemented  

**Goal:** Offline CLI [`scripts/convert-har.mjs`](../scripts/convert-har.mjs) converting between Playwright **attach** `.har.zip` and **embed** `.har` (both directions).

**Guide:** [`CONVERT_HAR.md`](../CONVERT_HAR.md)

**Non-goal:** In-app UI convert button; server-side conversion; change Capture HAR recording (app already supports both formats).

---

## Locked decisions (approved)

| # | Decision |
|---|----------|
| 1 | Script: **`scripts/convert-har.mjs`** |
| 2 | Convert **`request.postData`** and **`response.content`** in both directions |
| 3 | **`--strict` by default** (missing sidecar / undecodable body → exit 1); opt out with `--no-strict` |
| 4 | Embed `.har` JSON formatting: **same as Playwright embed** → **compact** `JSON.stringify` (no pretty indent). Optional `--pretty` |
| 5 | **Extract shared helpers now** → [`scripts/lib/har-archive.mjs`](../scripts/lib/har-archive.mjs); refactor [`scripts/replay-har.mjs`](../scripts/replay-har.mjs) to import them |
| 6 | In-app UI — **out of scope** |
| 7 | **Reverse convert (embed → zip) — in scope** |

---

## Formats

| Format | Layout | Bodies |
|--------|--------|--------|
| **Zip (attach)** | `har.har` + `<sha1>.ext` sidecars | `content._file` / `postData._file` |
| **Embed** | Single `.har` | `content.text`; binary → `encoding: "base64"` |

---

## Directions

| `--to` / auto | Input | Output |
|---------------|-------|--------|
| `embed` | `.har.zip` or `--dir` | `.har` |
| `zip` | `.har` (embed / DevTools with content) | `.har.zip` |

Auto: zip magic / `.har.zip` / `--dir` → embed; HAR JSON file → zip.

---

## Algorithms

### Zip → embed

1. Read `har.har` from zip/dir.
2. For each entry `response.content` and `request.postData`: if `_file`/`_sha1`, load sidecar (basename only), apply Playwright embed rules, delete `_file`/`_sha1`.
3. Write compact `.har` (or `--pretty`).

**Embed rules** (Playwright `isTextualMimeType` + non-font):

- Textual mime, resource not font → UTF-8 `text`, no `encoding`
- Else → base64 `text` + `encoding: "base64"`
- `size` = decoded byte length

### Embed → zip

1. Parse `.har`.
2. Decode bodies (`base64` or UTF-8); `sha1(bytes) + "." + ext`; set `_file`; remove `text`/`encoding`; dedupe sidecars.
3. Write `har.har` (compact) + sidecars; pack with `zip` CLI.

**Prereqs:** `unzip` + `zip` on PATH.

---

## CLI

```bash
node scripts/convert-har.mjs export.har.zip
node scripts/convert-har.mjs site.har --out site.har.zip
node scripts/convert-har.mjs --to embed export.har.zip
node scripts/convert-har.mjs --to zip site.har
node scripts/convert-har.mjs --dir /tmp/session --to embed
node scripts/convert-har.mjs export.har.zip --no-strict   # warn, continue
node scripts/convert-har.mjs export.har.zip --pretty
node scripts/convert-har.mjs export.har.zip --dry-run
```

| Flag | Default |
|------|---------|
| `--strict` | **on** |
| `--no-strict` | warn and skip bad bodies |
| Embed JSON | compact (Playwright-like); `--pretty` optional |

---

## Shared module

[`scripts/lib/har-archive.mjs`](../scripts/lib/har-archive.mjs):

- `findHarInDir`, `unzipToTemp`, `readHarJsonFromZip`, `isZipFile`
- `isTextualMimeType`, `extensionForMimeType`, `sha1Hex`, `attachFilenameForBuffer`
- `decodeEmbedBodyBytes`, `applyEmbedContent`, `applyAttachContent`
- `writeHarZipFromDir` (`zip` CLI)

`replay-har.mjs` imports unzip/find/read helpers from this module.

---

## Docs (with implement)

- [x] `CONVERT_HAR.md`
- [x] Links: README HAR section, `REPLAY_SCRIPT.md`, CHANGELOG
- [x] This plan → **implemented**

---

## Related

- [`docs/HAR_ZIP_IMPLEMENT_PLAN.md`](HAR_ZIP_IMPLEMENT_PLAN.md)
- [`CONVERT_HAR.md`](../CONVERT_HAR.md)
- [`REPLAY_SCRIPT.md`](../REPLAY_SCRIPT.md)
- Playwright `harTracer._storeResponseContent`
