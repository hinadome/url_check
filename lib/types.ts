export type HeaderPair = {
  name: string;
  value: string;
};

export type DnsOverride = {
  host: string;
  ip: string;
};

/** Result of server-side URL validation before a browser check. */
export type ValidatedUrlTarget = {
  url: URL;
  host: string;
  /** Public IP chosen for Chromium DNS pin; null when not resolved (e.g. skipDnsLookup). */
  pinnedIp: string | null;
};

/**
 * How Playwright records HAR bodies when `captureHar` is true.
 * - `json` — `content: "embed"` → `.har` JSON (binaries as base64 in HAR)
 * - `zip` — `content: "attach"` → `.har.zip` (binaries as files)
 */
export type HarFormat = "zip" | "json";

/**
 * Chromium `--net-log-capture-mode` when `captureNetLog` is true.
 * - `default` — strip private info (cookies / auth / raw bytes)
 * - `includeSensitive` — cookies / auth headers
 * - `everything` — include raw socket bytes (largest / most sensitive)
 */
export type NetLogCaptureMode =
  | "default"
  | "includeSensitive"
  | "everything";

export type CheckRequest = {
  url: string;
  headers?: HeaderPair[];
  dnsOverride?: DnsOverride;
  /** When true, Playwright ignores TLS certificate errors (default false). */
  ignoreCertErrors?: boolean;
  /**
   * When true, record a Playwright HAR for the session and return it in the
   * response (ephemeral; not written to app storage). Default false.
   */
  captureHar?: boolean;
  /** HAR packaging when `captureHar` is true. Default `json`. */
  harFormat?: HarFormat;
  /**
   * When true, record Chromium NetLog via `--log-net-log` and return it in the
   * response (ephemeral; not written to app storage). Default false.
   */
  captureNetLog?: boolean;
  /**
   * NetLog capture granularity when `captureNetLog` is true. Default `default`
   * (strip private info). Maps to `--net-log-capture-mode`.
   */
  netLogCaptureMode?: NetLogCaptureMode;
  /** Chromium `--disable-http2` for this check. Default false. */
  disableHttp2?: boolean;
  /**
   * Disable HTTP/3 for this check. Mapped to Chromium `--disable-quic`
   * (there is no `--disable-http3`). Default false.
   */
  disableHttp3?: boolean;
  /**
   * Preset: force both disables (≈ HTTP/1.1 only). Default false.
   * Server expands to disableHttp2 + disableHttp3.
   */
  http11Only?: boolean;
};

/** Server feature gates from env (GET /api/config). Default allow when unset. */
export type FeatureFlags = {
  allowIgnoreCertErrors: boolean;
  allowCaptureHar: boolean;
  allowCaptureNetLog: boolean;
  allowHttpProtocolControls: boolean;
};

export type ResourceSummaryData = {
  links: string[];
  images: string[];
  stylesheets: string[];
  scripts: string[];
  iframes: string[];
  other: string[];
};

export type NetworkBodyEncoding = "text" | "base64" | "empty";

/** Playwright request.timing() / Resource Timing–style phases (ms; -1 = unavailable). */
export type ResourceTiming = {
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
};

/** Page-level PerformanceNavigationTiming snapshot (ms relative to time origin). */
export type NavigationTimingSnapshot = {
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  connectEnd: number;
  secureConnectionStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  domInteractive: number;
  domContentLoadedEventStart: number;
  domContentLoadedEventEnd: number;
  domComplete: number;
  loadEventStart: number;
  loadEventEnd: number;
  redirectCount: number;
  type: string;
};

export type NetworkRequestEntry = {
  url: string;
  host: string;
  /** HTTP method (GET, POST, …) */
  method: string;
  status: number;
  contentType: string;
  contentSize: number | null;
  resourceType: string;
  /** ISO-8601 timestamp when the response was observed */
  date: string;
  /** IP from response.serverAddr(); null if unavailable */
  remoteIp: string | null;
  /** Port from response.serverAddr(); null if unavailable */
  remotePort: number | null;
  /** e.g. http/1.1, h2 — from response.httpVersion() */
  httpVersion: string | null;
  /** Per-request Resource Timing from request.timing() */
  timing: ResourceTiming | null;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** How `body` should be interpreted in the Content tab */
  bodyEncoding: NetworkBodyEncoding;
  /** Plain text, base64 string, or empty when no body */
  body: string;
  /** True when body was truncated to the capture size limit */
  bodyTruncated: boolean;
};

/**
 * Request that failed without an HTTP response (Playwright `requestfailed`).
 * Often corresponds to HAR entries with `response.status: -1`.
 */
export type NetworkFailedRequestEntry = {
  url: string;
  host: string;
  /** HTTP method (GET, POST, …) */
  method: string;
  /** Usually -1 when no HTTP response */
  status: number;
  resourceType: string;
  /** ISO-8601 timestamp when the failure was observed */
  date: string;
  /** Playwright `request.failure()?.errorText` (e.g. net::ERR_…) */
  failureText: string;
  requestHeaders: HeaderPair[];
};

/**
 * Subresource blocked by the SSRF browser guard (Playwright route abort).
 * Separate from `networkFailedRequests` (Playwright `requestfailed`).
 */
export type NetworkSsrfBlockedRequestEntry = {
  url: string;
  host: string;
  method: string;
  resourceType: string;
  /** ISO-8601 timestamp when the block was observed */
  date: string;
  /** Why the SSRF guard blocked this request */
  blockReason: string;
  requestHeaders: HeaderPair[];
};

export type CheckResponse = {
  finalUrl: string;
  status: number;
  title: string | null;
  html: string;
  screenshotBase64: string;
  resources: ResourceSummaryData;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  networkRequests: NetworkRequestEntry[];
  /** Failed / aborted requests (no HTTP response); empty if none */
  networkFailedRequests: NetworkFailedRequestEntry[];
  /** Requests blocked by the SSRF browser route guard; empty if none */
  networkSsrfBlockedRequests: NetworkSsrfBlockedRequestEntry[];
  /** Main document Navigation Timing (once per check) */
  navigationTiming: NavigationTimingSnapshot | null;
  /** Host pinned for Chromium DNS when SSRF guard is enabled */
  dnsPinnedHost: string | null;
  /** Public IP pinned for Chromium DNS when SSRF guard is enabled */
  dnsPinnedIp: string | null;
  /** Whether the SSRF browser guard (DNS pin + route abort) ran for this check */
  ssrfBrowserGuardEnabled: boolean;
  dnsOverride: DnsOverride | null;
  /** Whether this check ignored TLS certificate errors */
  ignoreCertErrors: boolean;
  /** Chromium `--disable-http2` was applied for this check */
  disableHttp2: boolean;
  /** HTTP/3 disabled via Chromium `--disable-quic` for this check */
  disableHttp3: boolean;
  /** Both protocol disables applied (HTTP/1.1-only intent) */
  http11Only: boolean;
  /** Chromium launch args added for protocol restrictions (empty if none) */
  chromiumProtocolArgs: string[];
  /**
   * True when navigation failed with ERR_HTTP2_PROTOCOL_ERROR and the check
   * was automatically retried with `--disable-http2`.
   */
  http2FallbackApplied: boolean;
  /** HAR packaging used for this check, or null when HAR was not requested */
  harFormat: HarFormat | null;
  /**
   * Full HAR 1.2 JSON text when `captureHar` + `harFormat: "json"` succeeded
   * within the soft size limit; otherwise null. Binaries are base64-in-HAR.
   */
  har: string | null;
  /**
   * Playwright HAR session as a zip (base64 for JSON transport) when
   * `captureHar` + `harFormat: "zip"` succeeded within the soft byte limit;
   * otherwise null. Zip uses `content: "attach"` (binaries as files).
   */
  harZipBase64: string | null;
  /**
   * Set when HAR was requested but could not be returned (e.g. over size limit).
   * Check results still succeed; only HAR download is unavailable.
   */
  harError: string | null;
  /** NetLog capture mode used for this check, or null when NetLog was not requested */
  netLogCaptureMode: NetLogCaptureMode | null;
  /**
   * Chromium NetLog JSON as base64 when `captureNetLog` succeeded within the
   * soft byte limit; otherwise null. Decode and save as `.json` for
   * https://netlog-viewer.appspot.com/
   */
  netLogBase64: string | null;
  /**
   * Set when NetLog was requested but could not be returned (e.g. over size).
   * Check results still succeed; only NetLog download is unavailable.
   */
  netLogError: string | null;
  timingMs: number;
  error?: string;
};
