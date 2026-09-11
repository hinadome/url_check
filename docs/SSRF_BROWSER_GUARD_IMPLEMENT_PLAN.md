# SSRF hardening — DNS pin + request route abort

**Status:** Implemented (locked decisions below).  
**Goal:** Close the gap between Node URL validation and Playwright Chromium’s own DNS / redirects / subresource fetches, so checks cannot reach private, loopback, link-local, or cloud-metadata addresses after the initial `validateUrl` pass.

**Related security review finding:** DNS rebinding (TOCTOU) and redirect/subresource SSRF when an open `/api/check` drives Chromium.

---

## Background

### What we do today

| Step | Where | Behavior |
|------|--------|----------|
| 1 | [`lib/validate.ts`](../lib/validate.ts) `validateUrl` | Scheme/host checks; Node `dns.lookup`; reject private/reserved IPs |
| 2 | Optional Force DNS | User-supplied public IP → Chromium `--host-resolver-rules=MAP host ip` |
| 3 | [`lib/playwright-fetch.ts`](../lib/playwright-fetch.ts) | `chromium.launch` → `page.goto(url)` — Chromium **resolves DNS again**, follows redirects, loads subresources |

Without Force DNS, the IP Node checked is **not** pinned into Chromium. Redirects and third-party hosts are **never** re-checked against the private-IP policy.

### Attack sketches

**A — DNS rebinding**

1. `evil.example` TTL low → first lookup public → `validateUrl` OK  
2. Chromium lookups again → `169.254.169.254` / `10.x` → SSRF  

**B — Redirect / subresource**

1. `https://public.example/` validates OK  
2. `302` → `http://169.254.169.254/` or page loads `http://192.168.1.1/admin`  
3. Playwright follows / fetches — no second `validateUrl`  

### Mitigations (complementary)

| Layer | Mechanism | Stops | Does not stop alone |
|-------|-----------|--------|---------------------|
| **1. DNS pin** | After validation, `--host-resolver-rules=MAP <urlHost> <validatedPublicIp>` | Rebinding on the **main** hostname | Redirects / other hosts |
| **2. Route abort** | `page.route("**/*", …)` re-validate each request URL (and resolved IPs); `route.abort()` if unsafe | Redirects + most subresource SSRF | Needs careful async DNS; edge protocols |
| **3. Egress firewall** (ops) | Host/container deny RFC1918 / link-local / metadata | Hard backstop | Not an app-code change |

This plan covers **1 + 2** in-app. Layer 3 stays in DEPLOYMENT guidance.

---

## Design

### Phase 1 — Auto DNS pin for the navigation host

1. Extend validation to return the **chosen public address** used for the check (not only the `URL` object), e.g.:

   ```ts
   type ValidatedTarget = {
     url: URL;
     /** Hostname as in the URL (normalized) */
     host: string;
     /** Public IP Node resolved (or literal IP URL / Force DNS IP) */
     pinnedIp: string;
   };
   ```

2. Resolution rules:

   | Case | `pinnedIp` |
   |------|------------|
   | URL host is a public literal IP | That IP |
   | Force DNS override | Override IP (already public + host match) |
   | Normal hostname | Prefer one public address from `lookup({ all: true })` (document v4-vs-v6 preference — recommend **first public A/AAAA in lookup order**, or prefer IPv4 if both) |

3. Launch Chromium with:

   ```text
   --host-resolver-rules=MAP <host> <pinnedIp>
   ```

   Merge with existing Force DNS / protocol / NetLog args. If Force DNS is set, pin is the override IP (same as today).

4. **Do not** pin arbitrary third-party hosts in v1 (only the check URL hostname).

5. Echo on `CheckResponse` (optional but useful for ops):

   - `dnsPinnedHost: string | null`
   - `dnsPinnedIp: string | null`

### Phase 2 — Playwright route guard (re-validate every request)

1. After `context.newPage()`, before `goto`:

   ```ts
   await page.route("**/*", async (route) => {
     const reqUrl = route.request().url();
     if (!(await isSafeRequestUrl(reqUrl))) {
       await route.abort("blockedbyclient");
       return;
     }
     await route.continue();
   });
   ```

2. `isSafeRequestUrl(url: string)`:

   - Allow only `http:` / `https:` (abort `file:`, `ws:` to private, etc. — document WS policy: **abort non-http(s)** or only abort if host resolves private)
   - Reuse shared private-IP / blocked-hostname helpers from `lib/validate.ts` (extract to `lib/ssrf.ts` or export existing functions)
   - Resolve hostname with `dns.lookup({ all: true })`; if **any** address is private/reserved → unsafe
   - Fail **closed** on DNS errors (abort)
   - Literal IP hosts: check IP directly
   - Cache allow/deny per hostname for the lifetime of one check (avoid N lookups for same CDN host)

3. **Main document** navigation: if aborted, `goto` fails — surface a clear error (e.g. “Blocked redirect or navigation to private/reserved address”).

4. Subresources aborted quietly (network collector may show `requestfailed` — acceptable; document).

5. Interaction with **Capture HAR / NetLog**: aborted requests may appear as failures in HAR/NetLog; document as expected when SSRF guard trips.

### Shared policy module

Extract from `validate.ts` into something like `lib/ssrf-policy.ts`:

- `isPrivateOrReservedIp`
- `isBlockedHostname`
- `assertPublicResolvedAddresses(hostname)`
- `isSafeNavigationUrl(url)` / `isSafeRequestUrl(url)` used by both API validation and the route guard

Keep API `validateUrl` as the strict entry check; route guard uses the same predicates.

### Feature flag (recommended)

| Env | Default | Meaning |
|-----|---------|---------|
| `ENABLE_SSRF_BROWSER_GUARD` | **on** (or off-by-default for safer rollout — **decide below**) | When on: auto DNS pin + route abort |

**Recommendation:** default **on** for new deploys after bake-in; ship v1 as **default on** with `ENABLE_SSRF_BROWSER_GUARD=0` to disable if a legitimate lab needs to hit RFC1918 via a controlled path (generally discouraged — Force DNS already blocks private override IPs).

Alternatively default **off** until verified on Costco-class sites, then flip. Prefer **default on** only after manual QA checklist passes.

### Out of scope (v1)

- Full multi-host `--host-resolver-rules` map for every subresource (unbounded; use route abort instead)
- SOCKS/proxy-aware pinning
- Blocking all third-party hosts (would break real pages)
- Replacing host egress firewall
- Changing Network ACL / rate limit (already shipped)

### IPv6 / metadata hardening (same PR or follow-up)

While touching SSRF policy, optionally extend `isPrivateOrReservedIp` for:

- NAT64 `64:ff9b::/96` (embedded IPv4)
- 6to4 `2002::/16` embeddings  
- Explicit cloud metadata hosts (`metadata.google.internal`, etc.)

Track as **Phase 1b** in the same plan if small; else separate follow-up.

---

## Files touched (checklist)

- [x] `docs/SSRF_BROWSER_GUARD_IMPLEMENT_PLAN.md` (this file)
- [x] `lib/ssrf-policy.ts` — shared predicates + `evaluateRequestUrl`
- [x] `lib/validate.ts` — `validateUrlWithPin` / `ValidatedUrlTarget`
- [x] `lib/ssrf-browser-guard.ts` — route guard collector + attach
- [x] `lib/playwright-fetch.ts` — merge MAP args; `page.route` guard; echo fields
- [x] `app/api/check/route.ts` — pass pinned target into fetch
- [x] `lib/types.ts` — `networkSsrfBlockedRequests`, `dnsPinnedHost` / `dnsPinnedIp`, `ssrfBrowserGuardEnabled`
- [x] `components/NetworkSsrfRequestsPanel.tsx` — SSRF requests panel below Failed / incomplete requests
- [x] `.env.example`, `DEPLOYMENT.md`, `README.md` Security, `CHANGELOG.md`
- [x] Deploy comments (`url-checker.service`, Compose) for `ENABLE_SSRF_BROWSER_GUARD`

---

## Verification (manual)

1. Public site (e.g. `https://example.com/`) — check succeeds; meta shows pin if echoed.  
2. Force DNS to public IP — still works; MAP not duplicated conflicting.  
3. Rebinding simulation (or documented test host) — with guard on, Chromium stays on pinned public IP.  
4. Redirect-to-private test server (lab) — navigation aborted; clear error; no metadata body in results.  
5. Page with image `http://127.0.0.1/` — request aborted; main check may still succeed.  
6. Costco / heavy site smoke — no unexpected mass aborts; HAR/NetLog still usable.  
7. `ENABLE_SSRF_BROWSER_GUARD=0` — previous behavior restored.  
8. ACL + rate limit still work independently.

---

## Risks

1. **False positives** — aggressive abort of `ws:` / odd schemes; CDN host that briefly resolves dual-stack with a filtered address.  
2. **Latency** — per-host DNS in route handler; mitigate with per-check cache.  
3. **HAR noise** — more `requestfailed` / blocked entries.  
4. **`--host-resolver-rules` with multiple MAP** — only one host in v1; document Chromium syntax if we later add more.  
5. **HTTP/2 fallback retry** — second launch must re-apply the same MAP + route guard.

---

## Decisions locked (implemented)

| # | Topic | Locked decision |
|---|--------|-----------------|
| 1 | Ship DNS pin + route abort together? | **Yes** |
| 2 | Feature flag default | **On** when unset; disable with `ENABLE_SSRF_BROWSER_GUARD=0` |
| 3 | Pin address family | Prefer IPv4 when both public A and AAAA exist |
| 4 | WebSocket / non-http(s) | **Abort** non-`http(s)` in route guard |
| 5 | Echo pin on CheckResponse | **Yes** (`dnsPinnedHost` / `dnsPinnedIp`) |
| 6 | Extend IPv6/metadata blocklist | **Yes** (NAT64, 6to4, `metadata.google.internal`) |
| 7 | Host egress docs | DEPLOYMENT note (deny metadata/RFC1918) |
| 8 | UI for blocked subresources | **SSRF requests** panel below Failed / incomplete requests (`networkSsrfBlockedRequests`; hidden when empty) |

---

## Relationship to already-shipped access control

| Control | Purpose |
|---------|---------|
| `ENABLE_NETWORK_ACL` / rate limit | Who may call the app |
| This SSRF browser guard | What Chromium may reach **after** a check starts |

Both are recommended on shared hosts.
