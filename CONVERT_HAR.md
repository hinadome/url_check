# HAR format converter

Guide for [`scripts/convert-har.mjs`](scripts/convert-har.mjs): convert between Playwright **attach** `.har.zip` and **embed** `.har` (both directions).

Shared helpers live in [`scripts/lib/har-archive.mjs`](scripts/lib/har-archive.mjs) (also used by [`scripts/replay-har.mjs`](scripts/replay-har.mjs)).

---

## Prerequisites

```bash
# From repo root
npm install   # not required for convert itself, but zip/unzip must be on PATH
which unzip zip
```

---

## Formats

| Format | Layout | Bodies |
|--------|--------|--------|
| **Zip (attach)** | `har.har` + `<sha1>.ext` sidecars | `content._file` / `postData._file` |
| **Embed** | Single `.har` | `content.text`; binaries usually `encoding: "base64"` |

URL Checker Capture HAR can produce either (`harFormat: "zip"` | `"json"`). This tool converts **already downloaded** archives without re-capturing.

---

## Quick start

```bash
# Zip → embed (.har) — default when input is .har.zip
node scripts/convert-har.mjs ~/Downloads/export.har.zip
node scripts/convert-har.mjs ~/Downloads/export.har.zip --out site.har

# Embed → zip — default when input is .har
node scripts/convert-har.mjs ~/Downloads/site.har
node scripts/convert-har.mjs ~/Downloads/site.har --out site.har.zip

# Force direction
node scripts/convert-har.mjs --to embed export.har.zip
node scripts/convert-har.mjs --to zip site.har

# Unzipped attach directory → embed
node scripts/convert-har.mjs --dir /tmp/har-session --to embed --out site.har
```

---

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--to embed` \| `--to zip` | auto from input | Force direction |
| `--zip` / `--har` / `--dir` | — | Explicit input kind |
| `--out <path>` | next to input | Output path |
| `--strict` | **on** | Missing sidecar / bad body → exit 1 |
| `--no-strict` | — | Warn and continue |
| Embed JSON | **compact** (Playwright-like) | Optional `--pretty` |
| `--dry-run` | — | Summary only, no write |
| `-h` / `--help` | — | Usage |

Both **response content** and **request postData** are converted when present.

---

## Behavior notes

- Embed encoding matches Playwright: textual MIME → UTF-8 `text`; otherwise base64 + `encoding: "base64"` (fonts stay base64).
- Attach filenames are `sha1(bytes) + "." + ext` (Playwright-style).
- Sidecar paths are basenames only (`..` rejected).
- Round-trip preserves body **bytes**; JSON field order / formatting may differ.
- HARs may contain cookies/tokens — treat outputs as sensitive.

---

## Related

- Plan: [`docs/HAR_ZIP_TO_EMBED_CONVERT_PLAN.md`](docs/HAR_ZIP_TO_EMBED_CONVERT_PLAN.md)
- Replay: [`REPLAY_SCRIPT.md`](REPLAY_SCRIPT.md)
- Capture formats: [README — HAR capture](README.md#har-capture-playwright-session-archive)
