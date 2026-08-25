# HTTP protocol Chromium args — implement plan (review only)

**Status:** Implemented (review decisions locked below).  
**Goal:** Let users optionally restrict which HTTP versions Chromium may negotiate when Playwright loads a URL, by passing documented Chromium launch switches via `chromium.launch({ args })`.

**Why:** Playwright has **no** API parameter such as `httpVersion: "h2"`. Protocol is negotiated by Chromium. The supported control surface is **browser launch args**.

---

## Background (research summary)

### What Playwright exposes

| Capability | Supported? |
|------------|------------|
| Pass `httpVersion` on `page.goto` / `request.get` / `APIRequestContext` | **No** |
| Read negotiated version after response | **Yes** — `response.httpVersion()` (already used in Network column) |
| Pass Chromium flags at launch | **Yes** — `chromium.launch({ args: string[] })` |

URL Checker already launches Chromium in [`lib/playwright-fetch.ts`](../lib/playwright-fetch.ts):

```ts
const browser = await chromium.launch({
  headless: true,
  args: hostResolverArgs(dnsOverride), // today: only --host-resolver-rules when DNS override
});
```

### Official Chromium network switches (protocol-related)

Source of truth: Chromium [`network_switch_list.h`](https://chromium.googlesource.com/chromium/src/+/main/components/network_session_configurator/common/network_switch_list.h) (also mirrored under `chrome/common` historically).

#### Primary flags for this feature (recommended product surface)

| Chromium switch | Effect | Maps to user intent |
|-----------------|--------|---------------------|
| `--disable-http2` | Disables the HTTP/2 protocol | “Don’t use HTTP/2” → force fallback toward HTTP/1.1 (when H3 also off) |
| `--disable-quic` | Disables the **QUIC** protocol | **HTTP/3 runs over QUIC** → this is how you disable HTTP/3 |

#### Important: there is no `--disable-http3`

A search of Chromium’s network switch list does **not** define `--disable-http3`.  
User/docs language may say “disable HTTP/3”; implementation must map that to **`--disable-quic`**.

Using a fictional `--disable-http3` arg would be ignored or unreliable.

#### Related switches (document, do **not** expose in v1 UI unless requested)

| Switch | Purpose | Product recommendation |
|--------|---------|------------------------|
| `--enable-quic` | Explicitly enable QUIC (often default on modern Chromium) | Skip — redundant with default |
| `--origin-to-force-quic-on` | Comma-separated `host:port` list forced onto QUIC | Skip — niche / can break sites |
| `--quic-version` | Force a QUIC version string | Skip — expert/debug only |
| `--quic-connection-options` / `--quic-client-connection-options` | QUIC option lists | Skip |
| `--quic-max-packet-length` | Max QUIC packet length | Skip |
| `--http2-grease-frame-type` | HTTP/2 frame greasing | Skip |
| `--http2-end-stream-with-data-frame` | HTTP/2 END_STREAM behavior | Skip |
| `--enable-user-controlled-alternate-protocol-ports` | Alternate-protocol on user ports | Skip |
| `--webtransport-developer-mode` | WebTransport cert leniency | Skip |
| `--testing-fixed-http-port` / `--testing-fixed-https-port` | Test-only fixed ports | Skip |

#### Other Chromium mechanisms (out of scope for v1)

- `chrome://flags` / `--enable-features=` / `--disable-features=` for experimental HTTP/3 bits — brittle across Chromium versions Playwright bundles; avoid as primary UX.
- Proxy / TLS settings — orthogonal.

### Effective protocol matrix (user checkboxes → Chromium args)

Assume default = **both unchecked** → no protocol args → Chromium negotiates normally (`http/1.1`, `h2`, and/or `h3` as ALPN allows).

| Disable HTTP/2 | Disable HTTP/3 (QUIC) | Launch args | Typical result |
|----------------|-----------------------|-------------|----------------|
| off | off | _(none)_ | Auto (h2/h3/1.1 as negotiated) |
| on | off | `--disable-http2` | No h2; may still use h3 or 1.1 |
| off | on | `--disable-quic` | No h3; may still use h2 or 1.1 |
| on | on | `--disable-http2` + `--disable-quic` | Effectively **HTTP/1.1 only** |

**Note:** Disabling only HTTP/2 does **not** guarantee HTTP/1.1 if the server prefers HTTP/3.

### Verification after implement

- Network panel `httpVersion` column already shows `response.httpVersion()` (`http/1.1`, `h2`, `h3`, …).
- Meta strip should echo which restrictions were applied (same pattern as DNS override / ignore cert / HAR).

---

## Product design (proposed)

### UI (form — directly under Force DNS resolution)

**Decided (review answers):**

Three controls (defaults **off**), placed **below Force DNS resolution** and **above** Custom headers:

1. **HTTP/1.1 only** (preset) → sets **both** of the below (and keeps them in sync while preset is on: checking preset turns both on; unchecking either independent box clears the preset; turning both on manually may optionally auto-check the preset).
2. **Disable HTTP/2** → adds `--disable-http2`
3. **Disable HTTP/3 (QUIC)** → adds `--disable-quic`  
   - Label copy **1A:** “Disable HTTP/3 (QUIC)” (not “Disable QUIC / HTTP/3”).

Short hint: “Restricts Chromium launch flags; negotiated version still shown in Network → HTTP.”

**Rejected for v1:** single dropdown only (checkboxes + preset chosen instead).

### API request (`POST /api/check`)

```ts
disableHttp2?: boolean;   // default false
disableHttp3?: boolean;   // default false — server maps to --disable-quic
```

Names use **HTTP/3** in the JSON field for UX clarity; docs state mapping to `--disable-quic`.

### API response

**Decided:** echo **booleans + args**.

```ts
disableHttp2: boolean;
disableHttp3: boolean;
/** True when both disables were applied (HTTP/1.1-only intent). */
http11Only?: boolean; // optional convenience echo if preset was used / both true
/** Chromium args added for protocol restrictions (empty if none). */
chromiumProtocolArgs: string[]; // e.g. ["--disable-http2", "--disable-quic"]
```

Request body can send `disableHttp2` / `disableHttp3` and/or `http11Only: true` (server expands preset to both disables before launch).

### Feature gate (env — **default allow**, like HAR / cert)

| Variable | Default | Meaning |
|----------|---------|---------|
| `ALLOW_HTTP_PROTOCOL_CONTROLS` | **allow when unset** | When disabled (`0`/`false`/`no`/`off`), hide UI and reject `disableHttp2`/`disableHttp3`/`http11Only: true` with **400** |

Wire into `lib/feature-flags.ts`, `GET /api/config`, `.env.example`, DEPLOYMENT.md, systemd/Compose comments.

---

## Implementation outline (when approved)

### Code touch list

| Area | Change |
|------|--------|
| `lib/types.ts` | Request/response fields; extend `FeatureFlags` |
| `lib/feature-flags.ts` | `allowHttpProtocolControls` |
| `lib/playwright-fetch.ts` | Merge protocol args with DNS `hostResolverArgs`; pass into `chromium.launch` |
| `app/api/check/route.ts` | Parse/validate/gate; pass into fetch; echo on success/error payloads |
| `app/api/config/route.ts` | Expose new flag |
| `components/UrlForm.tsx` | Checkboxes + submit payload |
| `app/page.tsx` (meta) | Show applied protocol restrictions when set |
| `.env.example` | Document gate |
| `README.md` / `CHANGELOG.md` / `DEPLOYMENT.md` | Document UI, API, gates, Chromium mapping |
| `docker-compose.yml` / `deploy/url-checker.service` | Optional commented `ALLOW_HTTP_PROTOCOL_CONTROLS=0` |

### Helper sketch (playwright-fetch)

```ts
function httpProtocolArgs(opts: {
  disableHttp2: boolean;
  disableHttp3: boolean;
}): string[] {
  const args: string[] = [];
  if (opts.disableHttp2) args.push("--disable-http2");
  if (opts.disableHttp3) args.push("--disable-quic"); // HTTP/3
  return args;
}

// launch:
args: [
  ...hostResolverArgs(dnsOverride),
  ...httpProtocolArgs({ disableHttp2, disableHttp3 }),
],
```

### Security / ops notes

- Same SSRF / open-checker model as today; protocol flags don’t add network reach.
- Flags are **allowlisted** internally (only these two switches) — do **not** accept arbitrary Chromium args from the client (RCE/escape risk if ever exposed).
- Playwright docs: custom `args` “at your own risk”; these two are stable Chromium network switches and low risk vs e.g. `--no-sandbox`.
- Per-check default **off** → no behavior change for existing users.

### Out of scope (v1)

- Forcing HTTP/2 or HTTP/3 (Chromium has no simple “force h2 only” product flag that is safe/reliable).
- Exposing raw/custom Chromium arg strings from the UI.
- Changing `APIRequestContext` (URL Checker uses browser navigation, not Node fetch for the main check).
- Replay script (`scripts/replay-har.mjs`) protocol args (can be a later follow-up).

### Test plan (manual)

1. Default check against a known `h2` site → Network shows `h2` (or `h3`).
2. Enable **Disable HTTP/2** only → no `h2` on document/resources (may still see `h3` or `http/1.1`).
3. Enable **Disable HTTP/3** only → no `h3`; may still see `h2`.
4. Enable both → expect `http/1.1` (or absence of `h2`/`h3`).
5. With `ALLOW_HTTP_PROTOCOL_CONTROLS=0`, UI hidden; API `400` if client sends true.
6. Combine with DNS override — both `--host-resolver-rules=…` and protocol flags present in launch args (verify via response echo `chromiumProtocolArgs`).

---

## Task checklist

- [x] Confirm product UX: dual checkboxes **+ HTTP/1.1 only preset**
- [x] Confirm field names: `disableHttp3` → `--disable-quic`; label “Disable HTTP/3 (QUIC)”
- [x] Confirm feature gate `ALLOW_HTTP_PROTOCOL_CONTROLS` **default-allow**
- [x] Confirm response echo: booleans + `chromiumProtocolArgs`
- [x] Implement types + feature flag + API + playwright args merge
- [x] Implement UrlForm (3 controls) + meta strip
- [x] Update README / CHANGELOG / DEPLOYMENT / `.env.example`
- [ ] Manual test matrix above
- [ ] (Optional follow-up) Replay script `--disable-http2` / `--disable-quic` CLI flags

---

## Review decisions (locked)

| # | Question | Decision |
|---|----------|----------|
| 1 | Label copy | **A** — **Disable HTTP/3 (QUIC)** |
| 2 | Echo field | **Booleans +** `chromiumProtocolArgs: string[]` |
| 3 | Preset | **Yes** — third control **HTTP/1.1 only** (sets both disables) |
| 4 | Gate default | **Default-allow** — `ALLOW_HTTP_PROTOCOL_CONTROLS` allow when unset |

---

## References

- Chromium network switches: [`network_switch_list.h`](https://chromium.googlesource.com/chromium/src/+/main/components/network_session_configurator/common/network_switch_list.h)
- Playwright `browserType.launch({ args })`: [BrowserType.launch](https://playwright.dev/docs/api/class-browsertype#browser-type-launch)
- Playwright `response.httpVersion()`: [Response.httpVersion](https://playwright.dev/docs/api/class-response#response-http-version)
- Existing launch site: [`lib/playwright-fetch.ts`](../lib/playwright-fetch.ts)
- Prior feature-gate pattern: [`lib/feature-flags.ts`](../lib/feature-flags.ts), [DEPLOYMENT.md — feature gates](../DEPLOYMENT.md#feature-gates-env--default-allow)
