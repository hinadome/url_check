# Failed / incomplete network requests in UI — implement plan

**Status:** implemented  
**Guide:** README [Failed / incomplete requests](../README.md#failed--incomplete-requests)

**Goal:** Show Playwright `requestfailed` traffic (typical HAR `response.status: -1`) in a panel **below** Network requests.

---

## Locked decisions (approved)

| # | Decision |
|---|----------|
| 1 | **Hide** panel when there are no failed entries |
| 2 | Incomplete-at-flush — **deferred** |
| 3 | **Yes** — separate failed-network CSV export |
| 4 | Cap default **500**, configurable via **`MAX_NETWORK_FAILED_ENTRIES`** |
| 5 | **Yes** — **Method** column |
| 6 | **Yes** — filters (URL, host, type, failure text) |

---

## Delivered

- Types: `NetworkFailedRequestEntry`, `CheckResponse.networkFailedRequests`
- Collector: `page.on("requestfailed")` + env cap (`lib/network-collector.ts`)
- UI: `components/NetworkFailedRequestsPanel.tsx` under Network requests
- Export: JSON + `exportNetworkFailedCsv` / Export menu item
- Docs: README, CHANGELOG, `.env.example`, docker-compose comment

## Deferred

- Incomplete-at-flush (requests with neither `response` nor `requestfailed` before end)
